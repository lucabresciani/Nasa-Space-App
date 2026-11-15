// UI store (DESIGN §5.2): mode, panel sizes, layers on, exaggeration, 2D/3D, reduced motion,
// intro seen, plus the field mode and collapse value the storyboards set (§6.4 u_mode, u_k).
// Defaults: tokens.json layout for panel sizes; everything without a source stays undefined.
import type { Route } from '../router'
import { TOKENS } from '../ui/tokens'
import { signal } from './signal'

export type Mode = 'plan' | 'fly' | 'report' | 'evidence'
export const MODES: readonly Mode[] = ['plan', 'fly', 'report', 'evidence']
export type FieldMode = 'bands' | 'margin'

/**
 * DESIGN §4.2: the mode an existing route belongs to (route names of router.ts). `satisfies` keeps the
 * keys equal to the router's route names: the removed views (D98 /nav, D99 /hud3d) have no key; their
 * old paths redirect (router.ts REMOVED_PATHS) before a mode is looked up.
 */
export const ROUTE_MODE: Readonly<Record<string, Mode>> = {
  console: 'plan',
  station: 'plan',
  trade: 'plan',
  mission: 'plan',
  conditions: 'fly',
  hud: 'fly',
  cuff: 'report',
  scorecard: 'evidence',
  about: 'evidence',
} satisfies Record<Exclude<Route['name'], 'notfound'>, Mode>

const REDUCED = '(prefers-reduced-motion: reduce)'
const mq = typeof matchMedia === 'function' ? matchMedia(REDUCED) : null

export const ui = {
  /** undefined until the shell (WS15 task 4) sets it from the route */
  mode: signal<Mode | undefined>(undefined),
  /** px, tokens.json layout */
  panels: {
    leftRail: signal<number>(TOKENS.layout.leftRail),
    sidebar: signal<number>(TOKENS.layout.sidebar),
    timeline: signal<number>(TOKENS.layout.timeline),
  },
  /** layer group → on; undefined = each map keeps its own defaults (console DEFAULT_VISIBLE) */
  layers: signal<Readonly<Record<string, boolean>> | undefined>(undefined),
  /** terrain exaggeration; undefined until config/design.yaml lands (DESIGN U1) */
  exaggeration: signal<number | undefined>(undefined),
  /** today's maps are 2D (ConsoleMap maxPitch 0) */
  view: signal<'2d' | '3d'>('2d'),
  reducedMotion: signal<boolean>(mq?.matches ?? false),
  introSeen: signal<boolean>(false),
  /** explicit field mode (storyboard / toggle); undefined = the U2 default rule (mission.ts) */
  fieldMode: signal<FieldMode | undefined>(undefined),
  /** collapse k ∈ [0, 1] (U3); undefined until a storyboard or toggle sets it */
  collapseK: signal<number | undefined>(undefined),
} as const

mq?.addEventListener?.('change', (e) => {
  ui.reducedMotion.value = e.matches
})

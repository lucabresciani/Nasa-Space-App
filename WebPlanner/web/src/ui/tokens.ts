// Typed access to the design tokens (DESIGN §3, WS15 task 1).
// CSS: use the custom properties from tokens.css (var(--color-select) …).
// JS (MapLibre paint, canvas, SVG built in code): use TOKENS here, never a literal.
// tokens.json is the frozen export; tokens.css is generated from it (scripts/gen-tokens.mjs).
import raw from './tokens.json'

export type Tokens = typeof raw
export const TOKENS: Readonly<Tokens> = raw

export type ColorToken = keyof Tokens['color']
export type MotionToken = keyof Tokens['motion']

/** camelCase → kebab-case, the rule gen-tokens.mjs uses for CSS names. */
function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** Colour value for JS consumers (e.g. MapLibre 'line-color'). */
export function color(name: ColorToken): string {
  return TOKENS.color[name]
}

/** CSS custom-property reference for a colour token, e.g. colorVar('cardBorder') = 'var(--color-card-border)'. */
export function colorVar(name: ColorToken): string {
  return `var(--color-${kebab(name)})`
}

/** True when the user asked for reduced motion (DESIGN §3.4). Safe outside a browser. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * A motion duration in ms for JS animations (camera, collapse, tweens). Ranged tokens take
 * 'min' or 'max' (default 'max'). Returns 0 under reduced motion, like the CSS variables.
 */
export function motionMs(name: MotionToken, which: 'min' | 'max' = 'max', reduced = prefersReducedMotion()): number {
  if (reduced) return 0
  const v: number | number[] = TOKENS.motion[name]
  return Array.isArray(v) ? v[which === 'min' ? 0 : 1] : v
}

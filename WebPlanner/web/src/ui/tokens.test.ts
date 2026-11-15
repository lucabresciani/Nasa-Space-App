// WS15 task 1 acceptance: tokens.css is generated from tokens.json and stays in sync with it.
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import tokens from './tokens.json'
import { TOKENS, color, colorVar, motionMs } from './tokens'

const UI = dirname(fileURLToPath(import.meta.url))
const WEB = join(UI, '..', '..')
const GEN = join(WEB, 'scripts', 'gen-tokens.mjs')
const css = readFileSync(join(UI, 'tokens.css'), 'utf8')

function rootBlock(text: string): Map<string, string> {
  const body = text.slice(text.indexOf(':root {'), text.indexOf('}'))
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]))
}
const vars = rootBlock(css)

describe('tokens.css', () => {
  it('equals a fresh render of tokens.json (regenerate → identical)', () => {
    const fresh = execFileSync(process.execPath, [GEN, '--stdout'], { encoding: 'utf8' })
    expect(fresh).toBe(css)
    expect(spawnSync(process.execPath, [GEN, '--check']).status).toBe(0)
  })

  it('has every colour of tokens.json as --color-*', () => {
    for (const [k, v] of Object.entries(tokens.color)) {
      const name = `--color-${k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`
      expect(vars.get(name), name).toBe(v)
    }
    expect(vars.get('--color-select')).toBe(tokens.color.select)
    expect(vars.get('--color-card-border')).toBe(tokens.color.cardBorder)
  })

  it('has font sizes, line heights, weights, families', () => {
    for (const [k, v] of Object.entries(tokens.font.size)) expect(vars.get(`--font-size-${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`)).toBe(`${v}px`)
    for (const [k, v] of Object.entries(tokens.font.lineHeight)) expect(vars.get(`--line-height-${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`)).toBe(`${v}px`)
    for (const [k, v] of Object.entries(tokens.font.weight)) expect(vars.get(`--font-weight-${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`)).toBe(String(v))
    expect(vars.get('--font-text')).toMatch(new RegExp(`^"${tokens.font.text}",`))
    expect(vars.get('--font-mono')).toMatch(new RegExp(`^"${tokens.font.mono}",`))
  })

  it('has spacing, radii, layout sizes, line widths, overlay opacity', () => {
    tokens.space.forEach((v, i) => expect(vars.get(`--space-${i}`)).toBe(`${v}px`))
    for (const [k, v] of Object.entries(tokens.radius)) expect(vars.get(`--radius-${k}`)).toBe(`${v}px`)
    expect(vars.get('--layout-top-bar')).toBe(`${tokens.layout.topBar}px`)
    expect(vars.get('--layout-left-rail-collapsed')).toBe(`${tokens.layout.leftRailCollapsed}px`)
    expect(vars.get('--layout-breakpoint-desktop')).toBe(`${tokens.layout.breakpoints.desktop}px`)
    expect(vars.get('--line-field-edge')).toBe(`${tokens.line.fieldEdgePx}px`)
    expect(vars.get('--line-focus-ring')).toBe(`${tokens.line.focusRingPx}px`)
    expect(vars.get('--overlay-opacity-min')).toBe(String(tokens.overlayOpacity.min))
  })

  it('has every motion duration, ranges as -min/-max', () => {
    expect(vars.get('--motion-panel-min')).toBe(`${tokens.motion.panelMs[0]}ms`)
    expect(vars.get('--motion-panel-max')).toBe(`${tokens.motion.panelMs[1]}ms`)
    expect(vars.get('--motion-camera-max')).toBe(`${tokens.motion.cameraMs[1]}ms`)
    expect(vars.get('--motion-collapse')).toBe(`${tokens.motion.collapseMs}ms`)
    expect(vars.get('--motion-route-draw')).toBe(`${tokens.motion.routeDrawMs}ms`)
    expect(vars.get('--motion-pulse-every')).toBe(`${tokens.motion.pulseEveryMs}ms`)
  })

  it('zeroes every motion duration under prefers-reduced-motion', () => {
    const i = css.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(i).toBeGreaterThan(0)
    const reduced = new Map([...css.slice(i).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]))
    const motionVars = [...vars.keys()].filter((k) => k.startsWith('--motion-'))
    expect(motionVars.length).toBe(11)
    expect([...reduced.keys()].sort()).toEqual(motionVars.sort())
    for (const v of reduced.values()) expect(v).toBe('0ms')
  })
})

describe('tokens.ts accessor', () => {
  it('reads tokens.json values and CSS names', () => {
    expect(TOKENS.color.safe).toBe(tokens.color.safe)
    expect(color('limit')).toBe(tokens.color.limit)
    expect(colorVar('textMuted')).toBe('var(--color-text-muted)')
    expect(vars.has('--color-text-muted')).toBe(true)
  })
  it('motionMs takes min/max and is 0 under reduced motion', () => {
    expect(motionMs('panelMs', 'min', false)).toBe(tokens.motion.panelMs[0])
    expect(motionMs('panelMs', 'max', false)).toBe(tokens.motion.panelMs[1])
    expect(motionMs('collapseMs', 'max', false)).toBe(tokens.motion.collapseMs)
    expect(motionMs('cameraMs', 'max', true)).toBe(0)
  })
})

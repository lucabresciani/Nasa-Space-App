#!/usr/bin/env node
// Generates web/src/ui/tokens.css from web/src/ui/tokens.json (WS15 task 1, U0, DESIGN §3).
// tokens.json is the frozen export (design bootstrap D1); never edit tokens.css by hand.
//
//   node scripts/gen-tokens.mjs           write src/ui/tokens.css
//   node scripts/gen-tokens.mjs --check   exit 1 if src/ui/tokens.css differs from a fresh render
//   node scripts/gen-tokens.mjs --stdout  print the CSS
//
// Every section of tokens.json has an explicit rule below; an unknown section or key makes the
// generator throw, so a new token is never silently dropped.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const JSON_PATH = resolve(here, '../src/ui/tokens.json')
const CSS_PATH = resolve(here, '../src/ui/tokens.css')

/** camelCase → kebab-case ("cardBorder" → "card-border"). */
export function kebab(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function num(v, where) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`tokens.json ${where}: expected a number, got ${JSON.stringify(v)}`)
  return v
}

function obj(v, where) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`tokens.json ${where}: expected an object`)
  return v
}

/** Strips a unit suffix from a key ("panelMs" → "panel", "fieldEdgePx" → "fieldEdge"). */
function stripSuffix(key, suffix) {
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) : key
}

// Generic fallbacks after the self-hosted family (not design values: only used before the WOFF2
// arrives or if it fails).
const FALLBACK = {
  text: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
}

/** Returns { main: [[name, value]], motion: [name] } in tokens.json order. */
export function tokenDecls(tokens) {
  const decls = []
  const motion = []
  const add = (name, value) => decls.push([`--${name}`, String(value)])
  const sections = {
    color(v) {
      for (const [k, c] of Object.entries(obj(v, 'color'))) {
        if (typeof c !== 'string') throw new Error(`tokens.json color.${k}: expected a string`)
        add(`color-${kebab(k)}`, c)
      }
    },
    overlayOpacity(v) {
      for (const [k, x] of Object.entries(obj(v, 'overlayOpacity'))) add(`overlay-opacity-${kebab(k)}`, num(x, `overlayOpacity.${k}`))
    },
    font(v) {
      const f = obj(v, 'font')
      for (const [k, x] of Object.entries(f)) {
        if (k === 'size' || k === 'lineHeight' || k === 'weight') {
          const prefix = { size: 'font-size', lineHeight: 'line-height', weight: 'font-weight' }[k]
          const unit = k === 'weight' ? '' : 'px'
          for (const [role, n] of Object.entries(obj(x, `font.${k}`))) add(`${prefix}-${kebab(role)}`, `${num(n, `font.${k}.${role}`)}${unit}`)
        } else if (typeof x === 'string') {
          const fb = FALLBACK[k]
          if (!fb) throw new Error(`tokens.json font.${k}: no fallback stack defined for this family role`)
          add(`font-${kebab(k)}`, `"${x}", ${fb}`)
        } else {
          throw new Error(`tokens.json font.${k}: unknown font token`)
        }
      }
    },
    space(v) {
      if (!Array.isArray(v)) throw new Error('tokens.json space: expected an array')
      v.forEach((n, i) => add(`space-${i}`, `${num(n, `space[${i}]`)}px`))
    },
    radius(v) {
      for (const [k, n] of Object.entries(obj(v, 'radius'))) add(`radius-${kebab(k)}`, `${num(n, `radius.${k}`)}px`)
    },
    motion(v) {
      for (const [k, x] of Object.entries(obj(v, 'motion'))) {
        if (!k.endsWith('Ms')) throw new Error(`tokens.json motion.${k}: motion keys must end in "Ms"`)
        const base = `motion-${kebab(stripSuffix(k, 'Ms'))}`
        if (Array.isArray(x)) {
          if (x.length !== 2) throw new Error(`tokens.json motion.${k}: expected [min, max]`)
          add(`${base}-min`, `${num(x[0], `motion.${k}[0]`)}ms`)
          add(`${base}-max`, `${num(x[1], `motion.${k}[1]`)}ms`)
          motion.push(`--${base}-min`, `--${base}-max`)
        } else {
          add(base, `${num(x, `motion.${k}`)}ms`)
          motion.push(`--${base}`)
        }
      }
    },
    layout(v) {
      for (const [k, x] of Object.entries(obj(v, 'layout'))) {
        if (k === 'breakpoints') {
          for (const [bp, n] of Object.entries(obj(x, 'layout.breakpoints'))) add(`layout-breakpoint-${kebab(bp)}`, `${num(n, `layout.breakpoints.${bp}`)}px`)
        } else {
          add(`layout-${kebab(k)}`, `${num(x, `layout.${k}`)}px`)
        }
      }
    },
    line(v) {
      for (const [k, n] of Object.entries(obj(v, 'line'))) {
        if (!k.endsWith('Px')) throw new Error(`tokens.json line.${k}: line keys must end in "Px"`)
        add(`line-${kebab(stripSuffix(k, 'Px'))}`, `${num(n, `line.${k}`)}px`)
      }
    },
  }
  for (const [section, value] of Object.entries(obj(tokens, 'root'))) {
    const rule = sections[section]
    if (!rule) throw new Error(`tokens.json: no generator rule for section "${section}" (add one in scripts/gen-tokens.mjs)`)
    rule(value)
  }
  const names = decls.map(([n]) => n)
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) throw new Error(`tokens.json: two tokens map to ${dup}`)
  return { decls, motion }
}

/** Renders tokens.css from the parsed tokens.json. Pure and deterministic. */
export function renderTokensCss(tokens) {
  const { decls, motion } = tokenDecls(tokens)
  const lines = [
    '/* GENERATED from tokens.json by web/scripts/gen-tokens.mjs. Do not edit by hand. */',
    '/* Regenerate: cd web && node scripts/gen-tokens.mjs  (a test fails when this file is stale). */',
    '/* Layout breakpoints are listed for JS (matchMedia); CSS custom properties do not work in @media. */',
    ':root {',
    ...decls.map(([n, v]) => `  ${n}: ${v};`),
    '}',
    '',
    '/* Reduced motion (DESIGN §3.4, kit rule 9): every motion duration is zero. */',
    '@media (prefers-reduced-motion: reduce) {',
    '  :root {',
    ...motion.map((n) => `    ${n}: 0ms;`),
    '  }',
    '}',
    '',
  ]
  return lines.join('\n')
}

function main(argv) {
  const css = renderTokensCss(JSON.parse(readFileSync(JSON_PATH, 'utf8')))
  if (argv.includes('--stdout')) {
    process.stdout.write(css)
    return 0
  }
  if (argv.includes('--check')) {
    let current = ''
    try {
      current = readFileSync(CSS_PATH, 'utf8')
    } catch {
      /* missing counts as stale */
    }
    if (current !== css) {
      console.error('src/ui/tokens.css is out of date with src/ui/tokens.json; run: node scripts/gen-tokens.mjs')
      return 1
    }
    console.log('tokens.css is in sync with tokens.json')
    return 0
  }
  writeFileSync(CSS_PATH, css)
  console.log(`wrote ${CSS_PATH}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}

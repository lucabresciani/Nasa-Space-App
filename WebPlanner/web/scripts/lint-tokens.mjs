#!/usr/bin/env node
// Token lint (DESIGN §9, kit rule 2): no colour, font-size, radius or duration literal in design
// code. Values come from src/ui/tokens.css (CSS) or src/ui/tokens.ts (JS), generated from tokens.json.
//
//   npm run lint:tokens                     scan every file in the configured scope
//   node scripts/lint-tokens.mjs FILE...    lint the given files (ignore + legacy lists still apply)
//
// Config: scripts/lint-tokens.config.json (scope, extensions, ignore, legacy allow-list).
// Exit 0 = clean, 1 = literals found, 2 = usage/config error.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const WEB = resolve(here, '..')
const CONFIG_PATH = join(here, 'lint-tokens.config.json')

const toPosix = (p) => p.split(sep).join('/')

/** Numbers in a CSS/JS value after var(...) references are removed. */
function literalNumbers(value) {
  let v = value
  // Remove var(...) (nested parentheses inside fallbacks included).
  for (let guard = 0; guard < 20 && /var\(/.test(v); guard++) v = v.replace(/var\((?:[^()]|\([^()]*\))*\)/g, ' ')
  return (v.match(/-?\d*\.?\d+/g) ?? []).map(Number)
}
const hasNonZero = (value) => literalNumbers(value).some((n) => n !== 0)
const hasNumber = (value) => literalNumbers(value).length > 0
const hasNonZeroTime = (value) => {
  let v = value
  for (let guard = 0; guard < 20 && /var\(/.test(v); guard++) v = v.replace(/var\((?:[^()]|\([^()]*\))*\)/g, ' ')
  return (v.match(/\d*\.?\d+m?s\b/g) ?? []).some((t) => parseFloat(t) !== 0)
}

// Each rule: regex with the global flag; optional test(match) to accept/reject a candidate.
const COMMON_RULES = [
  { id: 'color-hex', re: /(?<![\w&/#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g },
  { id: 'color-function', re: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g },
  // CSS declarations (also inside CSS-in-JS strings and template literals).
  { id: 'font-size', re: /(?<![\w-])font-size\s*:\s*([^;}"'`\n]*)/g, test: (m) => hasNumber(m[1]) },
  { id: 'font-size', re: /(?<![\w-])font\s*:\s*([^;}"'`\n]*)/g, test: (m) => /\d*\.?\d+(?:px|rem|em|pt|%)/.test(m[1].replace(/var\([^)]*\)/g, '')) },
  { id: 'radius', re: /(?<![\w-])border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius\s*:\s*([^;}"'`\n]*)/g, test: (m) => hasNonZero(m[1]) },
  { id: 'duration', re: /(?<![\w-])(?:transition|animation)(?:-duration|-delay)?\s*:\s*([^;}"'`\n]*)/g, test: (m) => hasNonZeroTime(m[1]) },
]
const SCRIPT_RULES = [
  { id: 'font-size', re: /\bfontSize\s*[:=]\s*['"`]?\s*(-?\d*\.?\d+)/g, test: (m) => Number(m[1]) !== 0 },
  { id: 'font-size', re: /['"](?:text-size|font-size)['"]\s*:\s*['"`]?\s*(-?\d*\.?\d+)/g, test: (m) => Number(m[1]) !== 0 },
  { id: 'font-size', re: /\.font\s*=\s*['"`][^'"`]*?\d*\.?\d+(?:px|pt|rem|em)/g },
  { id: 'radius', re: /\bborderRadius\s*[:=]\s*['"`]?\s*(-?\d*\.?\d+)/g, test: (m) => Number(m[1]) !== 0 },
  {
    id: 'duration',
    re: /\b(?:duration|delay|transitionDuration|animationDuration|transitionDelay|animationDelay)\s*[:=]\s*['"`]?\s*(-?\d*\.?\d+)/g,
    test: (m) => Number(m[1]) !== 0,
  },
  { id: 'duration', re: /['"][\w-]*-(?:duration|delay)['"]\s*:\s*['"`]?\s*(-?\d*\.?\d+)/g, test: (m) => Number(m[1]) !== 0 },
]

/** Blanks out comments, keeping newlines so line numbers stay right. */
function stripComments(text, isCss) {
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank)
  if (isCss) return out
  out = out.replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)))
  out = out.replace(/<!--[\s\S]*?-->/g, blank)
  return out
}

/** Returns the list of violations in one file's text. */
export function lintText(text, file) {
  const ext = extname(file)
  const isCss = ext === '.css'
  const code = stripComments(text, isCss)
  const rules = isCss ? COMMON_RULES : [...COMMON_RULES, ...SCRIPT_RULES]
  const lineStarts = [0]
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1)
  const pos = (idx) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, col: idx - lineStarts[lo] + 1 }
  }
  const out = []
  const seen = new Set()
  for (const rule of rules) {
    for (const m of code.matchAll(rule.re)) {
      if (rule.test && !rule.test(m)) continue
      const { line, col } = pos(m.index)
      const key = `${line}:${col}:${rule.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ file, line, col, rule: rule.id, text: m[0].trim().slice(0, 80) })
    }
  }
  return out.sort((a, b) => a.line - b.line || a.col - b.col)
}

export function loadConfig(path = CONFIG_PATH) {
  const c = JSON.parse(readFileSync(path, 'utf8'))
  for (const k of ['scope', 'extensions', 'ignore', 'legacy']) {
    if (!Array.isArray(c[k])) throw new Error(`${path}: "${k}" must be an array`)
  }
  return c
}

function globToRe(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return g.includes('/') ? new RegExp(`^${esc}$`) : new RegExp(`(^|/)${esc}$`)
}

/** 'lint' | 'ignored' | 'legacy' | 'out-of-scope' for a path relative to web/. */
export function classify(rel, cfg, explicit = false) {
  if (cfg.legacy.includes(rel)) return 'legacy'
  if (cfg.ignore.some((g) => globToRe(g).test(rel))) return 'ignored'
  if (!cfg.extensions.includes(extname(rel))) return 'out-of-scope'
  if (explicit) return 'lint'
  return cfg.scope.some((s) => rel.startsWith(s)) ? 'lint' : 'out-of-scope'
}

function walk(dir, acc) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}

function main(argv) {
  let cfg
  try {
    cfg = loadConfig()
  } catch (e) {
    console.error(`lint-tokens: ${e.message}`)
    return 2
  }
  const explicit = argv.filter((a) => !a.startsWith('--'))
  const files = explicit.length
    ? explicit.map((f) => resolve(process.cwd(), f))
    : cfg.scope.flatMap((s) => walk(join(WEB, s), []))
  for (const l of cfg.legacy) {
    if (!existsSync(join(WEB, l))) console.warn(`lint-tokens: legacy entry ${l} does not exist; remove it from the config`)
  }
  const problems = []
  let checked = 0
  for (const abs of files) {
    if (!existsSync(abs)) {
      console.error(`lint-tokens: no such file ${abs}`)
      return 2
    }
    const rel = toPosix(relative(WEB, abs))
    if (classify(rel, cfg, explicit.length > 0) !== 'lint') continue
    checked++
    problems.push(...lintText(readFileSync(abs, 'utf8'), rel))
  }
  for (const p of problems) console.log(`${p.file}:${p.line}:${p.col}  ${p.rule}  ${p.text}`)
  if (problems.length) {
    console.log(`\nlint-tokens: ${problems.length} literal(s) in ${checked} file(s). Use the tokens (src/ui/tokens.css vars, src/ui/tokens.ts in JS).`)
    return 1
  }
  console.log(`lint-tokens: clean (${checked} file(s), ${cfg.legacy.length} legacy file(s) allow-listed)`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}

// DESIGN §9 / kit rule 2: token lint passes on the repo and fails on literals.
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LINT = join(WEB, 'scripts', 'lint-tokens.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'lint-tokens-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function lint(...files: string[]) {
  return spawnSync(process.execPath, [LINT, ...files], { cwd: WEB, encoding: 'utf8' })
}
function fixture(name: string, text: string): string {
  const p = join(tmp, name)
  writeFileSync(p, text)
  return p
}

// Literals are assembled at runtime so this test file itself holds none.
const H = '#'
const BAD: Array<[string, string, string]> = [
  ['hex.css', `.a { color: ${H}F5D900; }`, 'color-hex'],
  ['short-hex.ts', `export const c = '${H}fff'`, 'color-hex'],
  ['rgb.css', `.a { background: ${'rgb'}a(0, 0, 0, 0.5); }`, 'color-function'],
  ['hsl.tsx', `export const c = '${'hsl'}(10 20% 30%)'`, 'color-function'],
  ['font.css', '.a { font-size: 13px; }', 'font-size'],
  ['font-short.css', '.a { font: 600 12px/16px Inter; }', 'font-size'],
  ['font.ts', 'export const s = { fontSize: 12 }', 'font-size'],
  ['canvas.ts', "declare const ctx: { font: string }; ctx.font = '12px sans-serif'", 'font-size'],
  ['maplibre.ts', "export const l = { 'text-size': 11 }", 'font-size'],
  ['radius.css', '.a { border-radius: 6px; }', 'radius'],
  ['radius.ts', "export const s = { borderRadius: '6px' }", 'radius'],
  ['transition.css', '.a { transition: opacity 200ms ease-out; }', 'duration'],
  ['anim.css', '.a { animation-duration: 1.5s; }', 'duration'],
  ['flyto.ts', 'export const o = { duration: 1200 }', 'duration'],
  ['fade.ts', "export const p = { 'raster-fade-duration': 300 }", 'duration'],
]

describe('lint-tokens', () => {
  it('passes on the repository (legacy files allow-listed)', () => {
    const r = lint()
    expect(r.stdout).toContain('lint-tokens: clean')
    expect(r.status).toBe(0)
  })

  it.each(BAD)('fails on %s', (name, text, rule) => {
    const r = lint(fixture(name, text))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(rule)
    expect(r.stdout).toContain(`${name}:1:`)
  })

  it('accepts token references, zeros, comments and hash routes', () => {
    const css = fixture(
      'good.css',
      [
        `/* palette: ${H}0C1211 is --color-bg */`,
        '.a { color: var(--color-text); background: var(--color-card); }',
        '.b { font-size: var(--font-size-body); font: var(--font-weight-body) var(--font-size-body)/var(--line-height-body) var(--font-text); }',
        '.c { border-radius: var(--radius-card); border-radius: 0; }',
        '.d { transition: opacity var(--motion-hover-max) linear; animation-duration: 0s; }',
      ].join('\n'),
    )
    const ts = fixture(
      'good.ts',
      [
        `// colour ${H}F5D900 comes from TOKENS`,
        "import { TOKENS } from './tokens'",
        "export const href = '#/scorecard?key=x'",
        "export const url = 'http://example.org/a'",
        'export const p = { "line-color": TOKENS.color.select, "raster-fade-duration": 0, duration: 0 }',
      ].join('\n'),
    )
    const r = lint(css, ts)
    expect(r.stdout + r.stderr).toContain('clean (2 file(s)')
    expect(r.status).toBe(0)
  })

  it('skips allow-listed legacy files', () => {
    expect(lint(join(WEB, 'src/map/consoleMap.ts')).status).toBe(0)
    expect(lint(join(WEB, 'src/map/consoleMap.ts')).stdout).toContain('clean (0 file(s)')
  })
})

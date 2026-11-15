// Kit rule 4 (static first): with VITE_LIVE off nothing from src/live/ is in the static bundle path.
// Walks the module graph of the static entry (src/main.ts) through every relative import, static and
// dynamic. No static edge may reach src/live/; a dynamic import of src/live/ is allowed only behind
// an import.meta.env.VITE_LIVE check (Vite inlines the flag, so with it off the branch and its chunk
// are dropped from the build).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLiveFlag } from './config'

const SRC = resolve(__dirname, '..')
const LIVE = resolve(SRC, 'live')
const inLive = (f: string) => f === LIVE || f.startsWith(LIVE + sep)

const STATIC_RE = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null // package or virtual module
  const base = resolve(dirname(from), spec.replace(/\?.*$/, ''))
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

function isTypeOnly(src: string, spec: string): boolean {
  return new RegExp(`import\\s+type\\s[^;]*from\\s+['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(src)
}

function walk(entry: string) {
  const seen = new Set<string>()
  const liveDynamic: { file: string; spec: string; guarded: boolean }[] = []
  const staticIntoLive: string[] = []
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.(ts|tsx)$/.test(file)) continue
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(STATIC_RE)) {
      const to = resolveImport(file, m[1])
      if (!to) continue
      if (inLive(to) && !isTypeOnly(src, m[1])) staticIntoLive.push(`${relative(SRC, file)} -> ${m[1]}`)
      if (!inLive(to)) stack.push(to)
    }
    for (const m of src.matchAll(DYNAMIC_RE)) {
      const to = resolveImport(file, m[1])
      if (!to) continue
      if (inLive(to)) {
        // the guard must sit on the same statement, at most 3 lines above the import()
        const before = src.slice(0, m.index).split('\n').slice(-4).join('\n')
        liveDynamic.push({ file: relative(SRC, file), spec: m[1], guarded: /import\.meta\.env\.VITE_LIVE\b/.test(before) })
      } else stack.push(to)
    }
  }
  return { seen, staticIntoLive, liveDynamic }
}

describe('static entry does not pull in src/live (VITE_LIVE off)', () => {
  const g = walk(resolve(SRC, 'main.ts'))

  it('the walk covers the static app', () => {
    expect(g.seen.size).toBeGreaterThan(20)
    expect([...g.seen].some((f) => f.endsWith(`${sep}views${sep}index.ts`))).toBe(true)
  })

  it('no static import edge from the app reaches src/live/', () => {
    expect(g.staticIntoLive).toEqual([])
    expect([...g.seen].filter(inLive)).toEqual([])
  })

  it('any dynamic import of src/live/ sits behind import.meta.env.VITE_LIVE', () => {
    expect(g.liveDynamic.filter((d) => !d.guarded)).toEqual([])
  })

  it('no file outside src/live/ imports from it, except a guarded dynamic import', () => {
    const offenders: string[] = []
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          if (!inLive(p)) visit(p)
          continue
        }
        if (!/\.(ts|tsx)$/.test(name)) continue
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(STATIC_RE)) {
          const to = resolveImport(p, m[1])
          if (to && inLive(to)) offenders.push(`${relative(SRC, p)}: ${m[0].trim()}`)
        }
      }
    }
    visit(SRC)
    expect(offenders).toEqual([])
  })

  it('VITE_LIVE is off unless set to 1 or true', () => {
    expect(isLiveFlag(undefined)).toBe(false)
    expect(isLiveFlag('')).toBe(false)
    expect(isLiveFlag('0')).toBe(false)
    expect(isLiveFlag('false')).toBe(false)
    expect(isLiveFlag('1')).toBe(true)
    expect(isLiveFlag('true')).toBe(true)
  })

  it('the test environment itself runs with the flag off', () => {
    expect(isLiveFlag(import.meta.env.VITE_LIVE)).toBe(false)
  })
})

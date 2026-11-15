#!/usr/bin/env node
// build-marvis.mjs: the web build the MARVIS simulator embeds (the game serves web/dist itself).
// Run from web/:   node scripts/build-marvis.mjs
//
//   1. npx tsc --noEmit        type errors are reported, never fatal (vite builds without type checking)
//   2. npx vite build          plain static build: real data, no live flags (every VITE_* variable is
//                              dropped from the environment; a web/.env* file that sets one stops the build)
//   3. product name            the exact upper-case token HOMELINE becomes MARVIS in dist/index.html and
//                              dist/assets/*.js. Never in dist/data, and never the lower-case or Title-case
//                              word: "homeline" is the walk-back boundary and part of identifiers
//                              (homeline_mission, homeline_eva_log, storage and layer keys).
//   4. checks                  dist/index.html, dist/assets and dist/marvis-bridge.json exist (the game
//                              accepts no build without them); no HOMELINE left in index.html and
//                              assets/*.js; homeline_mission and homeline_eva_log still in the assets.
// Exit code 0 = the build in web/dist is ready for the game; anything else = do not ship it.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(WEB, 'dist')
const FROM = 'HOMELINE'
const TO = 'MARVIS'
const MUST_KEEP = ['homeline_mission', 'homeline_eva_log']

const secs = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)} s`
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`
function fail(msg) {
  console.error(`build-marvis: FAILED: ${msg}`)
  process.exit(1)
}

/** Run a shell command in web/; returns { status, out } (stdout and stderr together). */
function run(cmd, env, show) {
  const r = spawnSync(cmd, { cwd: WEB, env, shell: true, encoding: 'utf8', stdio: show ? 'inherit' : 'pipe', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) fail(`${cmd}: ${r.error.message}`)
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Every file under dir (recursive): count and bytes. */
function tally(dir) {
  let files = 0
  let bytes = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const t = tally(p)
      files += t.files
      bytes += t.bytes
    } else {
      files += 1
      bytes += statSync(p).size
    }
  }
  return { files, bytes }
}

// The game's build is the plain static one: no flag from the shell, none from an env file.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITE_')))
const dropped = Object.keys(process.env).filter((k) => k.startsWith('VITE_'))
if (dropped.length) console.log(`build-marvis: ignoring ${dropped.join(', ')} from the environment (plain static build)`)
for (const f of readdirSync(WEB).filter((n) => /^\.env(\..+)?$/.test(n))) {
  const keys = readFileSync(join(WEB, f), 'utf8').split(/\r?\n/).map((l) => /^\s*(VITE_[A-Z0-9_]+)\s*=/.exec(l)?.[1]).filter(Boolean)
  if (keys.length) fail(`web/${f} sets ${keys.join(', ')}: the MARVIS build takes no build flags; move that file away and run again`)
}

// 1. Types: reported, not fatal.
let t0 = Date.now()
console.log('build-marvis: [1/4] npx tsc --noEmit')
const tsc = run('npx tsc --noEmit', env, false)
const typeErrors = tsc.out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l))
if (tsc.status !== 0) {
  console.warn(`build-marvis: WARNING: tsc reports ${typeErrors.length} type error(s); the build goes on. First lines:`)
  console.warn(tsc.out.split(/\r?\n/).filter(Boolean).slice(0, 20).join('\n'))
} else console.log(`build-marvis:       no type errors (${secs(t0)})`)

// 2. Build.
t0 = Date.now()
console.log('build-marvis: [2/4] npx vite build (real data, no live flags)')
const vite = run('npx vite build', env, true)
if (vite.status !== 0) fail(`vite build ended with exit code ${vite.status}`)
console.log(`build-marvis:       built (${secs(t0)})`)

// 3. Product name in the page and its scripts.
console.log(`build-marvis: [3/4] ${FROM} -> ${TO} in dist/index.html and dist/assets/*.js`)
const assetsDir = join(DIST, 'assets')
if (!existsSync(join(DIST, 'index.html'))) fail('dist/index.html is missing')
if (!existsSync(assetsDir)) fail('dist/assets is missing')
const scripts = readdirSync(assetsDir).filter((n) => n.endsWith('.js')).map((n) => join(assetsDir, n))
const targets = [join(DIST, 'index.html'), ...scripts]
let replaced = 0
let touched = 0
for (const p of targets) {
  const text = readFileSync(p, 'utf8')
  const n = text.split(FROM).length - 1
  if (!n) continue
  writeFileSync(p, text.split(FROM).join(TO))
  replaced += n
  touched += 1
}
console.log(`build-marvis:       ${replaced} occurrence(s) in ${touched} file(s)`)

// 4. Checks.
console.log('build-marvis: [4/4] checks')
const problems = []
if (!existsSync(join(DIST, 'marvis-bridge.json'))) problems.push('dist/marvis-bridge.json is missing (web/public/marvis-bridge.json): the game would refuse this build')
const left = targets.filter((p) => readFileSync(p, 'utf8').includes(FROM))
if (left.length) problems.push(`${FROM} is still in: ${left.map((p) => p.slice(DIST.length + 1)).join(', ')}`)
const allJs = scripts.map((p) => readFileSync(p, 'utf8'))
for (const id of MUST_KEEP) if (!allJs.some((t) => t.includes(id))) problems.push(`the identifier ${id} is not in dist/assets/*.js any more`)
if (problems.length) fail(problems.join('; '))

const total = tally(DIST)
const assets = tally(assetsDir)
const data = existsSync(join(DIST, 'data')) ? tally(join(DIST, 'data')) : { files: 0, bytes: 0 }
console.log(
  `build-marvis: OK  dist ${total.files} files ${mb(total.bytes)} (assets ${assets.files} files ${mb(assets.bytes)}, of them ${scripts.length} scripts; data ${data.files} files ${mb(data.bytes)}); ` +
    `${FROM} -> ${TO} ${replaced}x in ${touched} file(s); type errors ${typeErrors.length}; bridge marker present`,
)

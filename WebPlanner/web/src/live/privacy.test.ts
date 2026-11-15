// H3 (D71): the privacy note on /about appears only in live builds (VITE_LIVE=1). Known answers:
// - the note's text says only what the code does (each statement is pinned to its source below),
//   except the access log retention, which the team lead decided (D86) and is marked as policy;
// - mountPrivacy puts the note before the about page's "Licences" heading, once, and nowhere else;
// - the about view mounts it with the flag on and never touches src/live with the flag off.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountPrivacy, PRIVACY_TEXT, PRIVACY_TITLE } from './privacy'

const REPO = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8')

// --- a minimal DOM stand-in (vitest runs in node) -------------------------------------------------
interface FakeNode {
  tagName: string
  className: string
  textContent: string
  children: FakeNode[]
  parent?: FakeNode
}
const node = (tagName: string, textContent = '', className = ''): FakeNode => ({ tagName, className, textContent, children: [] })
const add = (p: FakeNode, ...kids: FakeNode[]) => {
  for (const k of kids) {
    k.parent = p
    p.children.push(k)
  }
  return p
}
const all = (n: FakeNode): FakeNode[] => n.children.flatMap((c) => [c, ...all(c)])
const matches = (n: FakeNode, sel: string) =>
  sel.split(',').some((s) => {
    const [tag, cls] = s.trim().split('.')
    return (!tag || n.tagName === tag.toUpperCase()) && (!cls || n.className.split(' ').includes(cls))
  })
/** Wraps a FakeNode tree in the few DOM members mountPrivacy uses. */
function dom(root: FakeNode) {
  const wrap = (n: FakeNode): Element =>
    ({
      get textContent() {
        return n.textContent
      },
      set textContent(v: string) {
        n.textContent = v
      },
      get className() {
        return n.className
      },
      set className(v: string) {
        n.className = v
      },
      get parentElement() {
        return n.parent ? wrap(n.parent) : null
      },
      querySelector: (s: string) => {
        const f = all(n).find((c) => matches(c, s))
        return f ? wrap(f) : null
      },
      querySelectorAll: (s: string) => all(n).filter((c) => matches(c, s)).map(wrap),
      append: (...kids: Element[]) => kids.forEach((k) => add(n, (k as unknown as { _n: FakeNode })._n)),
      insertBefore: (k: Element, ref: Element | null) => {
        const kn = (k as unknown as { _n: FakeNode })._n
        const rn = ref ? (ref as unknown as { _n: FakeNode })._n : null
        kn.parent = n
        const i = rn ? n.children.indexOf(rn) : -1
        if (i < 0) n.children.push(kn)
        else n.children.splice(i, 0, kn)
        return k
      },
      remove: () => {
        if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n)
        n.parent = undefined
      },
      _n: n,
    }) as unknown as Element
  const doc = { createElement: (tag: string) => wrap(node(tag.toUpperCase())) }
  return { root: wrap(root), doc: doc as unknown as Document }
}

/** The about page as the static view renders it (headings only). */
function aboutPage() {
  const page = node('DIV', '', 'page')
  add(page, node('H1', 'About HOMELINE'), node('P', 'A static site …'), node('H2', 'Data'), node('H2', 'Real, modelled, simulated'), node('H2', 'Licences'), node('P', 'Code: Apache-2.0.'))
  const outlet = add(node('MAIN', '', 'outlet'), page)
  return { outlet, page }
}
const headings = (page: FakeNode) => page.children.map((c) => (c.tagName === 'SECTION' ? `[${c.children.map((k) => k.textContent).join(' | ')}]` : c.textContent))

// --- the text --------------------------------------------------------------------------------------
describe('privacy note text', () => {
  const text = PRIVACY_TEXT.join(' ')

  it('is one short plain paragraph under a short heading', () => {
    expect(PRIVACY_TITLE).toBe('Privacy')
    expect(text.split(/\s+/).length).toBeLessThan(140)
    expect(text).not.toMatch(/hereby|pursuant|GDPR|data controller|consent/i)
  })

  it('says each fact once, in plain words', () => {
    for (const re of [
      /no accounts or logins/i,
      /no cookies/i,
      /plan inputs/i,
      /by (a )?hash/i,
      /run record/i,
      /salted hash/i,
      /in memory/i,
      /restart/i,
      /access logs?/i,
      /addresses/i,
      /nothing is sold or shared/i,
      /\/api\/docs\) loads .*cdn\.jsdelivr\.net/i,
      /static site works without the (live )?server/i,
    ])
      expect(text).toMatch(re)
  })

  // Each statement against the code it describes (a change there must revisit the note).
  it('no cookies: the server sets none and the web app reads or writes none; browser storage only in live/plans/ (D97)', () => {
    const py = (dir: string): string[] =>
      readdirSync(resolve(REPO, dir)).flatMap((n) => {
        const p = join(dir, n)
        if (statSync(resolve(REPO, p)).isDirectory()) return n === 'tests' ? [] : py(p)
        return n.endsWith('.py') ? [p] : []
      })
    for (const f of py('server')) expect(read(f), f).not.toMatch(/set_cookie|Set-Cookie/i)
    expect(read('server/app.py')).not.toMatch(/allow_credentials\s*=\s*True/)
    expect(read('server/ops/Caddyfile')).not.toMatch(/cookie/i)
    const ts = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) return ts(p)
        return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
      })
    const plansDir = resolve(__dirname, 'plans') + sep
    const storageUsers: string[] = []
    for (const f of ts(resolve(__dirname, '..'))) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/document\.cookie|sessionStorage|indexedDB|serviceWorker/)
      if (/localStorage/.test(src)) storageUsers.push(f)
    }
    // the one sanctioned exception: "My plans" (live/plans/), nowhere else
    expect(storageUsers.length).toBeGreaterThan(0)
    for (const f of storageUsers) expect(f.startsWith(plansDir), `${f} uses browser storage outside live/plans/`).toBe(true)
  })

  it('"My plans": the note says saved plans stay in this browser; the store touches storage only inside try', () => {
    expect(text).toMatch(/saved plans stay in this browser only/i)
    expect(text).toMatch(/nothing else uses browser storage/i)
    const src = read('web/src/live/plans/store.ts')
    // the storage object is obtained in one place, inside try, and every getItem/setItem call sits in a try block
    const body = src.replace(/\/\/.*$/gm, '').replace(/\/\*\*?[\s\S]*?\*\//g, '')
    const uses = [...body.matchAll(/localStorage|\.getItem\(|\.setItem\(|storage\(\)/g)]
    expect(uses.length).toBeGreaterThanOrEqual(4)
    for (const m of uses) {
      const before = body.slice(0, m.index)
      const opened = (before.match(/\btry \{/g) ?? []).length
      const closed = (before.match(/\} catch\b/g) ?? []).length
      expect(opened - closed, `${m[0]} at offset ${m.index} is not inside try`).toBe(1)
    }
    // nothing in plans/ sends anything
    for (const n of readdirSync(resolve(__dirname, 'plans')).filter((f) => !/\.test\./.test(f)))
      expect(readFileSync(resolve(__dirname, 'plans', n), 'utf8'), n).not.toMatch(/fetch\(|client\.|XMLHttpRequest|sendBeacon/)
  })

  it('rate limit: salted hashes of the address, salt random per process, kept in memory', () => {
    const src = read('server/api/auth/limits.py')
    expect(src).toMatch(/self\._salt = secrets\.token_bytes\(16\)/)
    expect(src).toMatch(/hashlib\.sha256\(self\._salt \+ host\.encode/)
    expect(src).toMatch(/self\._hits: OrderedDict\[/)
    expect(src).not.toMatch(/open\(|write_|sqlite|redis/i)
  })

  it('results: one folder per result hash; the run record holds inputs, engine, timings and no client field', () => {
    expect(read('config/backend.yaml')).toMatch(/dir: results\s+# relative to HL_SERVER_DATA \(env\); one folder per result hash/)
    const rr = JSON.parse(read('contracts/backend/run_record.schema.json'))
    expect(rr.additionalProperties).toBe(false)
    expect(Object.keys(rr.properties).sort()).toEqual(
      ['contract_version', 'hash', 'origin', 'label', 'inputs', 'engine', 'terrain_hash', 'status', 'started_utc', 'finished_utc', 'stages', 'files', 'range_flags', 'route_mode', 'feasibility', 'infeasible', 'error', 'dummy'].sort(),
    )
  })

  it('access logs: uvicorn and Caddy keep their default access logs (to stdout, with the client address)', () => {
    expect(read('Makefile')).toMatch(/uvicorn server\.app:app --host 127\.0\.0\.1/)
    expect(read('Makefile')).not.toMatch(/--no-access-log/)
    expect(read('server/ops/Dockerfile')).not.toMatch(/--no-access-log/)
    expect(read('server/ops/Caddyfile')).toMatch(/log \{\s*output stdout/)
  })

  // Policy, not code: the team lead decided (D86) that the access logs are deleted after judging ends.
  // Nothing in the repo deletes them, so this checks only that the note states the decision.
  it('access logs retention: deleted after judging ends (decided by the team lead, D86; not checked against code)', () => {
    expect(text).toMatch(/access logs list client addresses and are deleted after judging ends\./)
    expect(text).not.toMatch(/kept on the build machine/i)
  })

  it('API docs page: /api/docs is Swagger UI with FastAPI\'s default assets from cdn.jsdelivr.net (and its icon from fastapi.tiangolo.com)', () => {
    expect(read('config/backend.yaml')).toMatch(/^\s*docs_path: \/api\/docs\s/m)
    const src = read('server/api/plans/apidocs.py')
    // the page is FastAPI's get_swagger_ui_html with no asset URL overridden, so FastAPI's defaults apply
    expect(src).toMatch(/return get_swagger_ui_html\(openapi_url=spec_url, title="HOMELINE live API"\)/)
    expect(src).not.toMatch(/swagger_(js|css|favicon)_url/)
    // those defaults, in the locked FastAPI 0.163.0 (fastapi/openapi/docs.py), are
    //   https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js and .../swagger-ui.css,
    //   https://fastapi.tiangolo.com/img/favicon.png; a FastAPI upgrade must revisit the note
    expect(read('uv.lock')).toMatch(/name = "fastapi"\nversion = "0\.163\.0"\n/)
    expect(text).toMatch(/\(\/api\/docs\) loads its script and styles from cdn\.jsdelivr\.net and its icon from fastapi\.tiangolo\.com/)
  })
})

// --- mounting ------------------------------------------------------------------------------------
describe('mountPrivacy', () => {
  it('puts the note before the "Licences" heading of the about page', () => {
    const { outlet, page } = aboutPage()
    const { root, doc } = dom(outlet)
    const off = mountPrivacy(root, doc)
    expect(headings(page)).toEqual(['About HOMELINE', 'A static site …', 'Data', 'Real, modelled, simulated', `[${PRIVACY_TITLE} | ${PRIVACY_TEXT.join(' ')}]`, 'Licences', 'Code: Apache-2.0.'])
    const section = page.children.find((c) => c.tagName === 'SECTION')!
    expect(section.className).toBe('live-privacy')
    expect(section.children.map((c) => c.tagName)).toEqual(['H2', 'P'])
    off()
    expect(page.children.some((c) => c.tagName === 'SECTION')).toBe(false)
  })

  it('mounts once, however often it is called', () => {
    const { outlet, page } = aboutPage()
    const { root, doc } = dom(outlet)
    mountPrivacy(root, doc)
    mountPrivacy(root, doc)
    expect(page.children.filter((c) => c.tagName === 'SECTION')).toHaveLength(1)
  })

  it('does nothing when the about page is not shown (left before the chunk loaded)', () => {
    const page = add(node('DIV', '', 'page'), node('H1', 'Scorecard'), node('H2', 'Checks'))
    const { root, doc } = dom(add(node('MAIN', '', 'outlet'), page))
    const off = mountPrivacy(root, doc)
    expect(page.children.map((c) => c.tagName)).toEqual(['H1', 'H2'])
    off()
  })

  it('is exported from the live entry', async () => {
    const live = await vi.importActual<typeof import('./index')>('./index')
    expect(live.mountPrivacy).toBe(mountPrivacy)
  })
})

// --- the about view ----------------------------------------------------------------------------
// preactView is replaced by the identity so the view's About() runs through the string renderer
// (no DOM in node); the live entry is spied so the test sees whether the about view reaches it.
const liveSpy = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('../views/page', async (orig) => ({ ...(await orig<typeof import('../views/page')>()), preactView: (make: unknown) => make }))
vi.mock('./index', async (orig) => {
  const real = await orig<typeof import('./index')>()
  return { ...real, mountPrivacy: (root: unknown) => (liveSpy.calls.push(root), real.mountPrivacy(root as ParentNode)) }
})

describe('about view', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    liveSpy.calls.length = 0
  })

  const renderAbout = async () => {
    const { toHtml } = await import('./testing/html')
    const { view } = await import('../views/about')
    return toHtml((view as unknown as (r: unknown) => unknown)({ name: 'about' }))
  }

  it('flag on: shows the privacy note on the page', async () => {
    vi.stubEnv('VITE_LIVE', '1')
    const { outlet, page } = aboutPage()
    const { root, doc } = dom(outlet)
    vi.stubGlobal('document', Object.assign(doc, { querySelector: root.querySelector, querySelectorAll: root.querySelectorAll }))
    const html = await renderAbout()
    expect(html).toContain('About HOMELINE')
    await vi.waitFor(() => expect(liveSpy.calls).toHaveLength(1))
    expect(headings(page)).toContain(`[${PRIVACY_TITLE} | ${PRIVACY_TEXT.join(' ')}]`)
  })

  it('flag off: the about view never calls into src/live and renders no note', async () => {
    const html = await renderAbout()
    await new Promise((r) => setTimeout(r, 20))
    expect(liveSpy.calls).toEqual([])
    expect(html).not.toContain(PRIVACY_TITLE)
  })

  it('about.tsx reaches src/live by one guarded dynamic import only', () => {
    const src = readFileSync(resolve(__dirname, '../views/about.tsx'), 'utf8')
    const lines = src.split('\n').filter((l) => /['"]\.\.\/live/.test(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\s*if \(import\.meta\.env\.VITE_LIVE === '1'\) void import\('\.\.\/live'\)\.then\(\(m\) => m\.mountPrivacy\(document\)\)$/)
  })
})

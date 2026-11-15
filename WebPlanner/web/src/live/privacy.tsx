// Privacy note on /about, live builds only (H3, D71). The static site talks to no server, so the note
// exists only where the live layer does: views/about.tsx reaches it through one dynamic import behind
// VITE_LIVE, and with the flag off nothing of this file is in the build.
//
// Every sentence matches the code (privacy.test.ts pins each one to its source); change both together:
// - no accounts or logins: no user routes, D69 (the admin token is a team header, server/api/auth/admin.py);
// - no cookies; browser storage only for "My plans": server/ sets no cookie, web/src uses no cookie
//   API and no storage API outside live/plans/ (D97: saved plans, local storage, never sent);
// - plan inputs and results by hash, run record: $HL_SERVER_DATA/results/{hash} (config/backend.yaml
//   cache.dir, server/engine/results.py cache_dir), run_record.schema.json (inputs, engine, timings);
//   least recently used trees removed when the cache is full (server/api/plans/pinning.py evict);
// - rate limit: salted SHA-256 of the address, salt random per process, in memory (server/api/auth/limits.py);
// - access logs: uvicorn and Caddy defaults to stdout, with the client address (Makefile serve,
//   server/ops/Dockerfile, server/ops/Caddyfile); deleted after judging ends: a team-lead decision
//   (D86), policy rather than code;
// - API docs page: /api/docs (config/backend.yaml api.docs_path) is FastAPI's Swagger UI page with its
//   default asset URLs (server/api/plans/apidocs.py, fastapi 0.163.0 in uv.lock): script and stylesheet
//   from cdn.jsdelivr.net, icon from fastapi.tiangolo.com (D86);
// - not sold or shared: the server makes no outbound request with this data;
// - static site without the server: the live layer is lazy and optional (main.ts, isolation.test.ts).

export const PRIVACY_TITLE = 'Privacy'

export const PRIVACY_TEXT: readonly string[] = [
  'There are no accounts or logins and no cookies. Saved plans stay in this browser only; nothing else uses browser storage.',
  'The live server keeps the plan inputs it computes (with their title) and the results, filed by a hash of the inputs, each with a run record: engine version, stages and timings.',
  'The least recently used results are removed when its cache is full.',
  'To limit how many computations one address can start, it keeps salted hashes of addresses, in memory only, cleared on restart.',
  'Its standard access logs list client addresses and are deleted after judging ends.',
  'Nothing is sold or shared.',
  'The API documentation page (/api/docs) loads its script and styles from cdn.jsdelivr.net and its icon from fastapi.tiangolo.com, so opening it contacts those third parties.',
  'The static site works without the live server.',
]

/**
 * Insert the note before the about page's "Licences" heading under `root`. Does nothing when that
 * heading is not there (the visitor left /about before this chunk loaded) or the note is already in.
 * Returns cleanup. The note sits inside the page, so the page's own unmount removes it too.
 */
export function mountPrivacy(root: ParentNode, doc: Document = document): () => void {
  const at = [...root.querySelectorAll('h2')].find((h) => h.textContent === 'Licences')
  const page = at?.parentElement
  if (!at || !page || page.querySelector('.live-privacy')) return () => {}
  const section = doc.createElement('section')
  section.className = 'live-privacy'
  const h2 = doc.createElement('h2')
  h2.textContent = PRIVACY_TITLE
  const p = doc.createElement('p')
  p.textContent = PRIVACY_TEXT.join(' ')
  section.append(h2, p)
  page.insertBefore(section, at)
  return () => section.remove()
}

// Generic view of a file whose contract is still loose (structure not fixed by SPEC: coverage, rems,
// clock, v2 summary ...). Shows its scalar leaves as a key/value table, each number through <Num>,
// so the page works whatever structure the producer proposes, and nothing is invented.
import { Num } from './Num'

type Leaf = { path: string; v: number | string | boolean | null }

/** Scalar leaves of a JSON value, depth-first, up to maxDepth levels and maxRows rows (arrays skipped). */
export function scalarLeaves(v: unknown, maxDepth = 3, maxRows = 40, prefix = ''): Leaf[] {
  const out: Leaf[] = []
  const walk = (x: unknown, p: string, d: number) => {
    if (out.length >= maxRows) return
    if (x === null || typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') {
      if (p !== 'dummy') out.push({ path: p, v: x })
      return
    }
    if (Array.isArray(x) || typeof x !== 'object' || d >= maxDepth) return
    for (const [k, y] of Object.entries(x)) walk(y, p ? `${p}.${k}` : k, d + 1)
  }
  walk(v, prefix, 0)
  return out
}

export function LooseTable({ value, file, maxRows }: { value: unknown; file: string; maxRows?: number }) {
  const rows = scalarLeaves(value, 3, maxRows ?? 40)
  if (!rows.length) return <p class="muted">No scalar values in {file}.</p>
  return (
    <table class="mini loose">
      <tbody>
        {rows.map((r) => (
          <tr>
            <td>
              <code>{r.path}</code>
            </td>
            <td class="r">{typeof r.v === 'number' ? <Num v={r.v} file={file} /> : r.v === null ? <span class="num-unknown">unknown</span> : String(r.v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

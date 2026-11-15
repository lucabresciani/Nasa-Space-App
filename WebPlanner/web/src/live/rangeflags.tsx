// Run-record range flags (F26): inputs outside their config range, flagged by the server and never
// clamped. One component for the live result (view.tsx), the permalink and the provenance view
// (planview.tsx). The values are the user's own inputs, not computed numbers.
import { EXTRAPOLATION_TEXT } from './crew'
import type { RangeFlag } from './types'

export function RangeFlags({ flags, title = 'Range flags' }: { flags: readonly RangeFlag[] | null | undefined; title?: string }) {
  if (!flags || flags.length === 0) return null
  return (
    <section class="live-range-flags-box" role="note">
      <h3>{title}</h3>
      <p class="live-extrapolation">Inputs {EXTRAPOLATION_TEXT}.</p>
      <ul class="live-range-flags">
        {flags.map((f) => (
          <li key={f.key} data-key={f.key}>
            <code>{f.key}</code>
            {f.value !== undefined ? ` = ${f.value}` : ''}: {f.note}
          </li>
        ))}
      </ul>
    </section>
  )
}

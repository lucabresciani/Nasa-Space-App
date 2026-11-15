// Numbers on live views (brief rule 4: numbers through the result's manifest). Built from the same
// parts as the app's number component (components/Num.tsx): resolveProvenance + formatValue and the
// same num-* classes. Num itself reads the app-wide static manifest (prov/store) and links to the
// static scorecard, so a live value would be checked against the wrong manifest and recorded as an
// unbacked static number; LiveNum takes the live result's own manifest and links to its provenance
// view (#/plan/{hash}). Proposed for WS5: optional `manifest` and `href` props on Num, then LiveNum
// becomes <Num manifest={...} href={...}/>.
import { formatValue, resolveProvenance } from '../prov/provenance'
import type { Manifest } from '../data/types'

/** Provenance view of a live result (owned by U3, WS13 task 3). */
export const planHref = (hash: string) => `#/plan/${hash}`

export interface LiveNumProps {
  v: number | null | undefined
  /** Result-tree file the value was read from (e.g. scenarios/index.json). */
  file: string
  /** Manifest key the caller expects. */
  k?: string
  units?: string | null
  dp?: number
  /** The live result's manifest.json (null while no stage has written it). */
  manifest: Manifest | null
  /** Result hash, for the provenance link. */
  hash: string
}

/**
 * A number from a live result tree. Shown only when the result's manifest backs it (key or
 * file + value); otherwise the value is withheld ("not in manifest yet"), so a live view never shows
 * a number its manifest lacks (brief KAT).
 */
export function LiveNum({ v, file, k, units, dp, manifest, hash }: LiveNumProps) {
  if (v === null || v === undefined) {
    return (
      <span class="num num-unknown" title={`unknown (null in ${file})`}>
        {formatValue(v, units)}
      </span>
    )
  }
  const r = resolveProvenance(manifest, { key: k, file, value: v })
  if (r.status === 'ok' || r.status === 'matched') {
    const e = r.entry
    return (
      <a class="num num-ok num-live" href={planHref(hash)} title={`live manifest: ${r.key}\nfile: ${e.file}\nscript: ${e.script}\ncommit: ${e.commit}\nutc: ${e.utc}`}>
        {formatValue(v, units, { dp })}
      </a>
    )
  }
  const why = r.status === 'no-manifest' ? 'the result has no manifest.json yet' : r.status === 'mismatch' ? `manifest key ${r.key} holds a different value` : `no entry in the result's manifest for this value in ${file}`
  return (
    <span class="num num-unbacked num-withheld" title={why}>
      not in manifest yet
    </span>
  )
}

export interface ScreenNumProps {
  v: number | null | undefined
  units?: string | null
  dp?: number
}

/**
 * A number from the instant preview (POST /pads/screen, PadScreen). The contract gives the preview
 * no manifest (it is a screening estimate from the station fields, not a result tree), so the value
 * is shown flagged as such; the full plan's numbers go through LiveNum.
 */
export function ScreenNum({ v, units, dp }: ScreenNumProps) {
  const unknown = v === null || v === undefined
  return (
    <span class={`num ${unknown ? 'num-unknown' : 'num-screen'}`} title="instant preview (POST /pads/screen, station fields): an estimate with no manifest entry; compute the full plan for manifest-backed numbers">
      {formatValue(v, units, { dp })}
    </span>
  )
}

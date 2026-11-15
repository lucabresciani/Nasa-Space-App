// Every on-screen science number goes through <Num>: it prints the stored value (no rounding unless the caller asks for display decimals),
// links it to its manifest.json entry on the scorecard, and flags it when no entry backs it.
import { href } from '../router'
import { formatValue } from '../prov/provenance'
import { lookup } from '../prov/store'

export interface NumProps {
  v: number | string | boolean | null | undefined
  /** Data file (under data/) the value was read from. */
  file: string
  /** Manifest key the caller expects (optional; falls back to file + value). */
  k?: string
  units?: string | null
  /** Display formatting for string values (e.g. a UTC timestamp); numbers are never reformatted. */
  fmt?: (v: string) => string
  className?: string
  /** Display decimals (the link and tooltip keep the stored value). */
  dp?: number
  /** Show + on positive values. */
  signed?: boolean
  /** Display text for a boolean value [true, false] (the manifest keeps the boolean). */
  boolText?: [string, string]
}

export function Num({ v, file, k, units, className, fmt, dp, signed, boolText }: NumProps) {
  const text = typeof v === 'string' && fmt ? fmt(v) : typeof v === 'boolean' && boolText ? boolText[v ? 0 : 1] : formatValue(v, units, { dp, signed })
  const stored = dp !== undefined && typeof v === 'number' ? `\nstored value: ${v}` : ''
  if (v === null || v === undefined) {
    return (
      <span class={`num num-unknown ${className ?? ''}`} title={`unknown (null in ${file})`}>
        {text}
      </span>
    )
  }
  const r = lookup({ key: k, file, value: v })
  if (r.status === 'ok' || r.status === 'matched') {
    const e = r.entry
    const tip = `manifest: ${r.key}${stored}\nfile: ${e.file}\nscript: ${e.script}\ncommit: ${e.commit}\nutc: ${e.utc}`
    return (
      <a class={`num num-ok ${className ?? ''}`} href={href({ name: 'scorecard', key: r.key })} title={tip}>
        {text}
      </a>
    )
  }
  const why =
    r.status === 'mismatch'
      ? `manifest key ${r.key} holds a different value`
      : r.status === 'no-manifest'
        ? 'manifest.json not loaded'
        : `no manifest entry for this value in ${file}${r.expectedKey ? ` (expected key ${r.expectedKey})` : ''}`
  return (
    <span class={`num num-unbacked ${className ?? ''}`} title={why + stored}>
      {text}
    </span>
  )
}

/** A number taken from config/*.yaml: cites the config key instead of a manifest key. */
export function CfgNum({ v, source, units }: { v: number | string; source: string; units?: string | null }) {
  return (
    <span class="num num-config" title={`from ${source}`}>
      {formatValue(v, units)}
    </span>
  )
}

/** A number computed in the browser from backed inputs (e.g. the D9 leash slider): says so. */
export function DerivedNum({ v, units, how }: { v: number | null; units?: string | null; how: string }) {
  return (
    <span class="num num-derived" title={`computed in the browser: ${how}`}>
      {formatValue(v, units)}
    </span>
  )
}

// JSON export and import of plan_inputs.json (F28, D52, D69: permalinks plus JSON files, no share
// codes, no accounts). Export writes the canonical form (keys sorted at every level, 2-space indent,
// trailing newline), so import(export(x)) gives x back and export(import(file)) gives the same bytes.
// Import checks the file client-side before anything is sent: size cap and title cap from
// config/backend.yaml limits, JSON, and plan_inputs.schema.json (unknown fields refused).
// The route (D97, v1.2.0) travels in the same file and is checked by the schema; its errors are
// replaced by plans/route.ts checkRoute's, which name the stop in plain words.
import { TITLE_MAX_CHARS, UPLOAD_MAX_BYTES } from './config'
import { checkRoute } from './plans/route'
import { validatePlanInputs } from './schemacheck'
import type { PlanInputs } from './types'

/** Download name of an exported plan (the contract's file name, D52). */
export const EXPORT_FILE_NAME = 'plan_inputs.json'

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    )
  }
  return v
}

/** Canonical JSON text: keys sorted (code-point order) at every level, 2-space indent, final newline. */
export function canonicalJson(v: unknown): string {
  return `${JSON.stringify(sortKeys(v), null, 2)}\n`
}

export interface PlanExport {
  fileName: string
  text: string
  /** data: URL of the text, for an <a download> (no Blob URL to revoke; plan inputs are small). */
  href: string
}

export function exportPlanInputs(inputs: PlanInputs): PlanExport {
  const text = canonicalJson(inputs)
  return { fileName: EXPORT_FILE_NAME, text, href: `data:application/json;charset=utf-8,${encodeURIComponent(text)}` }
}

export type ImportCheck = { ok: true; inputs: PlanInputs } | { ok: false; errors: string[] }

/** UTF-8 size of a string in bytes. */
export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

/** Check the text of a plan_inputs.json file. `bytes` = the file's size (default: the text's UTF-8 size). */
export function checkPlanInputsText(text: string, bytes = utf8Bytes(text)): ImportCheck {
  if (bytes > UPLOAD_MAX_BYTES) return { ok: false, errors: [tooLarge(bytes)] }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`not JSON: ${e instanceof Error ? e.message : String(e)}`] }
  }
  const errors = checkPlanInputsDoc(doc)
  if (errors.length) return { ok: false, errors }
  const title = (doc as { title?: string }).title
  if (title !== undefined && [...title].length > TITLE_MAX_CHARS) return { ok: false, errors: [`title is longer than ${TITLE_MAX_CHARS} characters (limits.title_max_chars)`] }
  return { ok: true, inputs: doc as PlanInputs }
}

/**
 * Errors of a parsed plan_inputs document against plan_inputs.schema.json; errors inside `route` are
 * given as checkRoute's readable messages (the schema's stay when checkRoute finds nothing). [] = valid.
 */
export function checkPlanInputsDoc(doc: unknown): string[] {
  const schema = validatePlanInputs(doc)
  const inRoute = (e: string) => /^\$\.route(\.|\[|:)/.test(e)
  const route = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>).route : undefined
  const readable = route === undefined ? [] : checkRoute(route, '$.route')
  const errors = schema.filter((e) => !(readable.length && inRoute(e))).map((e) => `plan_inputs.schema.json: ${e}`)
  return [...errors, ...readable.map((e) => `route: ${e}`)]
}

const tooLarge = (bytes: number) => `file is ${bytes} bytes; the limit is ${UPLOAD_MAX_BYTES} bytes (limits.upload_max_bytes)`

/** The parts of a browser File the import reads. */
export interface FileLike {
  size: number
  text(): Promise<string>
}

/** Check a picked file; an oversize file is refused before it is read. */
export async function checkPlanInputsFile(file: FileLike): Promise<ImportCheck> {
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, errors: [tooLarge(file.size)] }
  return checkPlanInputsText(await file.text(), file.size)
}

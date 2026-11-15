// Client-side check of the backend contracts (plan_inputs, run_record) with the app's JSON Schema
// subset checker (src/data/schema.ts) plus the three keywords those two schemas add: oneOf,
// uniqueItems and propertyNames. contract.test.ts uses the same functions for the mocks, and fails
// if a contract starts using a keyword neither checker knows.
import planInputsSchema from '../../../contracts/backend/plan_inputs.schema.json'
import runRecordSchema from '../../../contracts/backend/run_record.schema.json'
import { checkSchema, type JsonSchema } from '../data/schema'

type Doc = Record<string, unknown>

/** checkSchema plus oneOf, uniqueItems and propertyNames, applied wherever they sit in the schema. */
export function validate(v: unknown, s: JsonSchema, path = '$'): string[] {
  const out = checkSchema(v, s, path).map((e) => `${e.path}: ${e.message}`)
  return out.length ? out : extras(v, s, path)
}

function extras(v: unknown, s: JsonSchema, path: string): string[] {
  const out: string[] = []
  if (Array.isArray(s.oneOf)) {
    const n = (s.oneOf as JsonSchema[]).filter((b) => validate(v, b, path).length === 0).length
    if (n !== 1) out.push(`${path}: matches ${n} oneOf branches`)
  }
  if (Array.isArray(s.allOf)) for (const b of s.allOf as JsonSchema[]) out.push(...extras(v, b, path))
  if (Array.isArray(v)) {
    if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) out.push(`${path}: items not unique`)
    if (s.items && typeof s.items === 'object') v.forEach((x, i) => out.push(...extras(x, s.items as JsonSchema, `${path}[${i}]`)))
  } else if (v && typeof v === 'object') {
    const o = v as Doc
    if (s.propertyNames && typeof s.propertyNames === 'object') {
      for (const k of Object.keys(o)) out.push(...validate(k, s.propertyNames as JsonSchema, `${path}.<${k}>`))
    }
    const props = (s.properties as Record<string, JsonSchema> | undefined) ?? {}
    for (const [k, x] of Object.entries(o)) {
      if (k in props) out.push(...extras(x, props[k], `${path}.${k}`))
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') out.push(...extras(x, s.additionalProperties as JsonSchema, `${path}.${k}`))
    }
  }
  return out
}

/** Inline local (#/$defs/…) and sibling-file $refs; siblings of a $ref are kept via allOf. */
function inline(node: unknown, root: Doc, files: Record<string, Doc>, depth = 0): unknown {
  if (depth > 50) throw new Error('$ref cycle')
  if (Array.isArray(node)) return node.map((n) => inline(n, root, files, depth))
  if (!node || typeof node !== 'object') return node
  const o = node as Doc
  if (typeof o.$ref === 'string') {
    const [file, frag = ''] = o.$ref.split('#')
    const doc = file ? files[file] : root
    if (!doc) throw new Error(`unknown $ref ${o.$ref}`)
    let target: unknown = doc
    for (const part of frag.split('/').filter(Boolean)) target = (target as Doc)[part]
    if (target === undefined) throw new Error(`unresolved $ref ${o.$ref}`)
    const resolved = inline(target, file ? doc : root, files, depth + 1)
    const { $ref: _r, ...rest } = o
    void _r
    return Object.keys(rest).length ? { ...(inline(rest, root, files, depth) as Doc), allOf: [resolved] } : resolved
  }
  const out: Doc = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === '$defs') continue
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as Doc).map(([pk, ps]) => [pk, inline(ps, root, files, depth)])) : inline(v, root, files, depth)
  }
  return out
}

export const PLAN_INPUTS_SCHEMA = planInputsSchema as JsonSchema
export const RUN_RECORD_SCHEMA = inline(runRecordSchema, runRecordSchema as Doc, { 'plan_inputs.schema.json': planInputsSchema as Doc }) as JsonSchema

/** Structure and names of a plan_inputs.json (unknown fields refused). [] = valid. */
export const validatePlanInputs = (v: unknown): string[] => validate(v, PLAN_INPUTS_SCHEMA)
/** A run record (GET /results/{hash}/provenance). [] = valid. */
export const validateRunRecord = (v: unknown): string[] => validate(v, RUN_RECORD_SCHEMA)

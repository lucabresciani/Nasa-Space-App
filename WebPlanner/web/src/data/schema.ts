// Minimal JSON Schema checker for the keywords contracts/*.schema.json use (draft 2020-12 subset):
// type, const, enum, pattern, required, properties, additionalProperties, items, prefixItems,
// minItems, maxItems, minimum, maximum, exclusiveMinimum, allOf, if/then/else. Annotations are
// ignored. schema.test.ts fails if contracts/ starts using a keyword not in SUPPORTED_KEYWORDS.
// The authoritative validator is tools/validate_contracts.py in CI; this guards the browser
// against a stale or wrong file, so a view shows an error instead of wrong numbers.

export type JsonSchema = { [k: string]: unknown }
export interface SchemaError {
  path: string
  keyword: string
  message: string
}

const MAX_ERRORS = 20

export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  'type', 'const', 'enum', 'pattern', 'required', 'properties', 'additionalProperties', 'items', 'prefixItems',
  'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'allOf', 'if', 'then', 'else',
  // annotations
  '$schema', '$id', 'title', 'description', 'format', 'x-contract-version', 'x-source', 'examples', '$comment',
])

function typeOk(v: unknown, t: string): boolean {
  switch (t) {
    case 'null':
      return v === null
    case 'boolean':
      return typeof v === 'boolean'
    case 'string':
      return typeof v === 'string'
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'array':
      return Array.isArray(v)
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v)
    default:
      return true
  }
}

export function checkSchema(value: unknown, schema: JsonSchema, path = '$'): SchemaError[] {
  const errors: SchemaError[] = []
  walk(value, schema, path, errors)
  return errors
}

const patternCache = new Map<string, RegExp>()

function walk(v: unknown, s: JsonSchema, path: string, out: SchemaError[]): void {
  if (out.length >= MAX_ERRORS) return
  const err = (keyword: string, message: string, p = path) => out.push({ path: p, keyword, message })

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]
    if (!types.some((t) => typeOk(v, t))) {
      if (types.includes('integer') && typeof v === 'number' && Number.isFinite(v)) err('integer', `expected integer, got ${v}`)
      else err('type', `expected ${types.join('|')}`)
      return
    }
  }
  if ('const' in s && v !== s.const) err('const', `expected ${JSON.stringify(s.const)}`)
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === v)) err('enum', `expected one of ${JSON.stringify(s.enum)}`)

  if (typeof v === 'string' && typeof s.pattern === 'string') {
    let re = patternCache.get(s.pattern)
    if (!re) patternCache.set(s.pattern, (re = new RegExp(s.pattern, 'u')))
    if (!re.test(v)) err('pattern', `${JSON.stringify(v)} does not match ${s.pattern}`)
  }

  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) err('minimum', `${v} < ${s.minimum}`)
    if (typeof s.maximum === 'number' && v > s.maximum) err('maximum', `${v} > ${s.maximum}`)
    if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) err('exclusiveMinimum', `${v} <= ${s.exclusiveMinimum}`)
  }

  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) err('minItems', `length ${v.length} < ${s.minItems}`)
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) err('maxItems', `length ${v.length} > ${s.maxItems}`)
    const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as JsonSchema[]) : []
    prefix.forEach((ps, i) => {
      if (i < v.length) walk(v[i], ps, `${path}[${i}]`, out)
    })
    if (s.items && typeof s.items === 'object') {
      for (let i = prefix.length; i < v.length && out.length < MAX_ERRORS; i++) walk(v[i], s.items as JsonSchema, `${path}[${i}]`, out)
    }
  }

  if (typeOk(v, 'object')) {
    const o = v as Record<string, unknown>
    for (const k of (s.required as string[] | undefined) ?? []) {
      if (!(k in o)) err('required', `missing "${k}"`, `${path}.${k}`)
    }
    const props = (s.properties as Record<string, JsonSchema> | undefined) ?? {}
    for (const [k, val] of Object.entries(o)) {
      if (k in props) walk(val, props[k], `${path}.${k}`, out)
      else if (s.additionalProperties === false) err('additionalProperties', `unexpected "${k}"`, `${path}.${k}`)
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(val, s.additionalProperties as JsonSchema, `${path}.${k}`, out)
    }
  }

  if (Array.isArray(s.allOf)) for (const sub of s.allOf as JsonSchema[]) walk(v, sub, path, out)

  if (s.if && typeof s.if === 'object') {
    const matched = checkSchema(v, s.if as JsonSchema).length === 0
    const branch = matched ? s.then : s.else
    if (branch && typeof branch === 'object') walk(v, branch as JsonSchema, path, out)
  }
}

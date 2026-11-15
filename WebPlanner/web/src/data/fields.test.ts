import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FieldsIndex } from './types'
import { unknownMaskField } from './fields'

const fi = JSON.parse(readFileSync(resolve(__dirname, '../../public/data-dummy/fields/index.json'), 'utf8')) as FieldsIndex

describe('unknown-terrain mask field', () => {
  it('is the shared slope field on the index grid', () => {
    const g = unknownMaskField(fi)!
    expect(g.file).toBe(fi.fields.slope.file)
    expect([g.width, g.height]).toEqual([fi.width, fi.height])
    expect(g.bounds).toEqual(fi.bounds)
  })
  it('null when the index has no shared slope field', () => {
    expect(unknownMaskField({ ...fi, fields: {} })).toBeNull()
  })
})

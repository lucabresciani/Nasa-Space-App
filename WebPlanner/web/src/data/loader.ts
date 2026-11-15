// The one data-loader module. Reads the active tree (data/ or data-dummy/), checks each file against
// its contract schema (contracts/ v1.1.x), refuses files no contract covers, and refuses
// dummy-flagged files in real mode. Images (PNG overlays, panoramas, fields) are referenced by URL.
import { DATA_MODE, dataUrl, type DataMode } from '../env'
import { schemaFor } from './contracts'
import { checkSchema, type JsonSchema, type SchemaError } from './schema'
import type {
  AnyFC,
  BandsFC,
  Card,
  CellState,
  Fix,
  Localisation,
  TileJson,
  VoDriftRow,
  Clock,
  Coreg,
  Coverage,
  Donki,
  EdgesFC,
  FieldsIndex,
  FixIntervalSummary,
  IsochroneFC,
  Manifest,
  PadFile,
  SitingPng,
  PartnerFC,
  Rad,
  Rems,
  RouteFC,
  ScenarioEntry,
  ScenariosIndex,
  Station,
  TimelineEvent,
  TradeTable,
  V1,
  V2,
} from './types'

export type DataErrorKind = 'missing' | 'invalid' | 'parse' | 'no-contract' | 'dummy-in-real'

export class DataError extends Error {
  readonly path: string
  readonly kind: DataErrorKind
  readonly errors: SchemaError[]
  constructor(path: string, kind: DataErrorKind, message: string, errors: SchemaError[] = []) {
    super(`${path}: ${message}`)
    this.name = 'DataError'
    this.path = path
    this.kind = kind
    this.errors = errors
  }
}

/** Returns the file text, or null when the file does not exist. */
export type TextFetcher = (path: string) => Promise<string | null>

/** `base`: root of another tree in the same contracts (a live result, D48); default the static tree. */
export const browserFetcher =
  (mode: DataMode, base?: string): TextFetcher =>
  async (path) => {
    const res = await fetch(dataUrl(path, mode, base))
    if (res.status === 404) return null
    if (!res.ok) throw new DataError(path, 'missing', `HTTP ${res.status}`)
    const text = await res.text()
    // Vite's dev server answers unknown paths with index.html; treat that as missing.
    if (/^\s*<!doctype html/i.test(text)) return null
    return text
  }

export interface LoaderOptions {
  /** Path -> contract schema (default: SCHEMA_MAP via schemaFor). Tests inject rows C has not added yet. */
  schemaFor?: (path: string) => JsonSchema | undefined
}

export function createLoader(fetchText: TextFetcher, mode: DataMode, opts: LoaderOptions = {}) {
  const lookupSchema = opts.schemaFor ?? schemaFor
  const cache = new Map<string, Promise<unknown>>()

  async function readJson(path: string): Promise<unknown> {
    const schema = lookupSchema(path)
    if (!schema) throw new DataError(path, 'no-contract', 'no contract in contracts/ covers this path')
    const text = await fetchText(path)
    if (text === null) throw new DataError(path, 'missing', 'file not found')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (e) {
      throw new DataError(path, 'parse', `not valid JSON (${(e as Error).message})`)
    }
    const errors = checkSchema(value, schema)
    if (errors.length) throw new DataError(path, 'invalid', `does not match its contract: ${errors[0].path} ${errors[0].message}`, errors)
    const flag = value && typeof value === 'object' && !Array.isArray(value) ? (value as { dummy?: unknown }).dummy : undefined
    if (mode === 'real' && flag === true) throw new DataError(path, 'dummy-in-real', 'dummy-flagged file in the real data tree')
    return value
  }

  function json<T>(path: string): Promise<T> {
    const key = path.replace(/^\.?\/+/, '')
    let p = cache.get(key)
    if (!p) {
      p = readJson(key)
      p.catch(() => cache.delete(key)) // allow a retry after a failure
      cache.set(key, p)
    }
    return p as Promise<T>
  }

  return {
    mode,
    json,
    scenarios: () => json<ScenariosIndex>('scenarios/index.json'),
    isochrones: (s: ScenarioEntry) => json<IsochroneFC>(s.files.isochrones),
    bands: (s: ScenarioEntry) => json<BandsFC>(s.files.bands),
    edges: (s: ScenarioEntry) => json<EdgesFC>(s.files.edges),
    partner: (s: ScenarioEntry) => json<PartnerFC>(s.files.partner),
    stations: () => json<Station[]>('stations.json'),
    card: (s: Station) => json<Card>(s.card),
    route: (scenario: string) => json<RouteFC>(`route_${scenario}.geojson`),
    timeline: (scenario: string) => json<TimelineEvent[]>(`timeline_${scenario}.json`),
    trade: () => json<TradeTable>('trade_table.json'),
    pad: () => json<PadFile>('pad.json'),
    sitingPng: () => json<SitingPng>('siting_png.json'),
    rad: () => json<Rad>('conditions/rad.json'),
    rems: () => json<Rems>('conditions/rems.json'),
    clock: () => json<Clock>('conditions/clock.json'),
    donki: () => json<Donki>('conditions/donki.json'),
    manifest: () => json<Manifest>('manifest.json'),
    fieldsIndex: () => json<FieldsIndex>('fields/index.json'),
    v1: () => json<V1>('validation/v1.json'),
    v2: () => json<V2>('validation/v2.json'),
    coverage: () => json<Coverage>('validation/coverage.json'),
    coreg: () => json<Coreg>('validation/coreg.json'),
    fixIntervalSummary: () => json<FixIntervalSummary>('nav/fix_interval_summary.json'),
    fixes: () => json<Fix[]>('nav/fixes.json'),
    localisation: (imageId: string) => json<Localisation>(`localisation/${imageId}.json`),
    voDrift: () => json<VoDriftRow[]>('vo/drift.json'),
    tilejson: () => json<TileJson>('tiles/basemap/tilejson.json'),
    cellstate: () => json<CellState>('terrain/cellstate.json'),
    geojson: (path: string) => json<AnyFC>(path),
    /** Run a load; resolve to null if the file is missing (any other failure still throws). */
    async optional<T>(fn: () => Promise<T>): Promise<T | null> {
      try {
        return await fn()
      } catch (e) {
        if (e instanceof DataError && e.kind === 'missing') return null
        throw e
      }
    },
  }
}

export type Loader = ReturnType<typeof createLoader>

let shared: Loader | undefined
/** The app-wide loader for the active data tree. */
export function data(): Loader {
  shared ??= createLoader(browserFetcher(DATA_MODE), DATA_MODE)
  return shared
}

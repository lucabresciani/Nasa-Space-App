// Data path pattern -> contract schema, mirroring SCHEMA_MAP in tools/validate_contracts.py
// (contracts v1.1.4; contracts.test.ts checks the two tables match row by row). Schemas are
// imported from contracts/ at build time, so the browser checks the frozen contract itself.
import bandsSchema from '../../../contracts/bands.schema.json'
import cardSchema from '../../../contracts/card.schema.json'
import cellstateSchema from '../../../contracts/cellstate.schema.json'
import clockSchema from '../../../contracts/clock.schema.json'
import coregSchema from '../../../contracts/coreg.schema.json'
import katsSchema from '../../../contracts/kats.schema.json'
import coverageSchema from '../../../contracts/coverage.schema.json'
import donkiSchema from '../../../contracts/donki.schema.json'
import edgesSchema from '../../../contracts/edges.schema.json'
import fieldsIndexSchema from '../../../contracts/fields_index.schema.json'
import fixIntervalSummarySchema from '../../../contracts/fix_interval_summary.schema.json'
import fixesSchema from '../../../contracts/fixes.schema.json'
import fp3dIndexSchema from '../../../contracts/fp3d_index.schema.json'
import goldenSchema from '../../../contracts/golden.schema.json'
import highlightsSchema from '../../../contracts/highlights.schema.json'
import horizonRingSchema from '../../../contracts/horizon_ring.schema.json'
import isochronesSchema from '../../../contracts/isochrones.schema.json'
import labelsSchema from '../../../contracts/labels.schema.json'
import localisationSchema from '../../../contracts/localisation.schema.json'
import manifestSchema from '../../../contracts/manifest.schema.json'
import montecarloSchema from '../../../contracts/montecarlo.schema.json'
import padSchema from '../../../contracts/pad.schema.json'
import padSummarySchema from '../../../contracts/pad_summary.schema.json'
import padsIndexSchema from '../../../contracts/pads_index.schema.json'
import partnerSchema from '../../../contracts/partner.schema.json'
import radSchema from '../../../contracts/rad.schema.json'
import remsSchema from '../../../contracts/rems.schema.json'
import routeSchema from '../../../contracts/route.schema.json'
import scenariosIndexSchema from '../../../contracts/scenarios_index.schema.json'
import sitingPngSchema from '../../../contracts/siting_png.schema.json'
import stationsSchema from '../../../contracts/stations.schema.json'
import terrainTilesSchema from '../../../contracts/terrain_tiles.schema.json'
import timelineSchema from '../../../contracts/timeline.schema.json'
import tilejsonSchema from '../../../contracts/tilejson.schema.json'
import tracksSchema from '../../../contracts/tracks.schema.json'
import tradeTableSchema from '../../../contracts/trade_table.schema.json'
import v1Schema from '../../../contracts/v1.schema.json'
import v2Schema from '../../../contracts/v2.schema.json'
import voDriftSchema from '../../../contracts/vo_drift.schema.json'
import voProbeSchema from '../../../contracts/vo_probe.schema.json'
import type { JsonSchema } from './schema'

export const SCHEMA_MAP: [pattern: string, schema: JsonSchema][] = [
  ['scenarios/index.json', scenariosIndexSchema],
  ['scenarios/*/isochrones.geojson', isochronesSchema],
  ['scenarios/bands_*.geojson', bandsSchema],
  ['scenarios/*/edges.geojson', edgesSchema],
  ['scenarios/*/partner.geojson', partnerSchema],
  ['stations.json', stationsSchema],
  ['cards/*.json', cardSchema],
  ['route_*.geojson', routeSchema],
  ['timeline_*.json', timelineSchema],
  ['trade_table.json', tradeTableSchema],
  ['pad.json', padSchema],
  ['conditions/rad.json', radSchema],
  ['manifest.json', manifestSchema],
  ['fields/index.json', fieldsIndexSchema],
  ['fp3d/index.json', fp3dIndexSchema],
  ['fp3d/horizon_ring.json', horizonRingSchema],
  ['localisation/*.json', localisationSchema],
  ['nav/montecarlo_*.json', montecarloSchema],
  ['nav/fixes.json', fixesSchema],
  ['nav/tracks_*.geojson', tracksSchema],
  ['nav/fix_interval_summary.json', fixIntervalSummarySchema],
  ['vo/probe.json', voProbeSchema],
  ['vo/drift.json', voDriftSchema],
  ['validation/v1.json', v1Schema],
  ['validation/v2.json', v2Schema],
  ['validation/coverage.json', coverageSchema],
  ['validation/coreg.json', coregSchema],
  ['validation/kats.json', katsSchema],
  ['conditions/rems.json', remsSchema],
  ['conditions/clock.json', clockSchema],
  ['conditions/donki.json', donkiSchema],
  ['siting_png.json', sitingPngSchema],
  ['tiles/basemap/tilejson.json', tilejsonSchema],
  ['terrain/cellstate.json', cellstateSchema],
  ['terrain/cellstate_conservative.json', cellstateSchema],
  // v1.1.4: D21 rover parking options (pads.ts PAD_SCHEMA_PATTERNS); four segments, no overlap
  ['scenarios/pads/index.json', padsIndexSchema],
  ['scenarios/pads/*/summary.json', padSummarySchema],
  ['scenarios/pads/*/bands_*.geojson', bandsSchema],
  ['scenarios/pads/*/edges.geojson', edgesSchema],
  ['scenarios/pads/*/partner.geojson', partnerSchema],
  ['scenarios/pads/*/route_*.geojson', routeSchema],
  ['scenarios/pads/*/timeline_*.json', timelineSchema],
  // v1.1.5: WS2 physiology golden vectors (D41)
  ['physio/golden.json', goldenSchema],
  // Design contracts v1 (DESIGN §6, D3)
  ['labels.json', labelsSchema],
  ['terrain/tiles.json', terrainTilesSchema],
  ['terrain_low/tiles.json', terrainTilesSchema],
  ['highlights/*.geojson', highlightsSchema],
]

/** fnmatch-style match where `*` does not cross `/` (one glob per path segment, as in Python). */
export function matchPattern(pattern: string, path: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
  return re.test(path)
}

/** The schema for a data path (first match wins), or undefined when no contract covers it. */
export function schemaFor(path: string): JsonSchema | undefined {
  return SCHEMA_MAP.find(([p]) => matchPattern(p, path))?.[1]
}

/** Contract version of every schema (x-contract-version), for the scorecard. */
export function contractVersions(): string[] {
  return [...new Set(SCHEMA_MAP.map(([, s]) => String(s['x-contract-version'])))]
}

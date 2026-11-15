// Partner line (F10) after D20 (user 2026-11-14 14:22, SPEC §11): the line is the cart haul only;
// dragging a suited crewmate is a finding (`drag_finding` in partner.geojson, manifest
// haul.drag.flat.*), never drawn. Label and note come from the file, else from config/haul.yaml.
import { CONFIG } from '../config'
import type { DragFinding, PartnerFC } from './types'

/** Layer label: the file's `label` (WS2), else config/haul.yaml partner_label filled in. */
export function partnerLabel(fc: PartnerFC | null): string {
  for (const f of fc?.features ?? []) {
    const p = f.properties ?? {}
    if (p.case !== 'drag' && typeof p.label === 'string' && p.label) return p.label
  }
  const c = CONFIG.haulPartnerCases[0] ?? 'cart'
  return CONFIG.haulPartnerLabel.replace('{case}', c).replace(/\{contour_min(?::g)?\}/, String(CONFIG.haulContourMin))
}

/** The features to draw: every case except drag (an older tree may still carry drag features). */
export function drawnPartner(fc: PartnerFC): PartnerFC {
  return { ...fc, features: fc.features.filter((f) => (f.properties ?? {}).case !== 'drag') }
}

/** The flat-ground drag finding, or null when the file carries none. */
export function dragFinding(fc: PartnerFC | null): DragFinding | null {
  const d = fc?.drag_finding
  return d && typeof d === 'object' ? d : null
}

/** Scenario id from scenarios/{id}/partner.geojson. */
export function partnerScenarioId(file: string): string | null {
  return /scenarios\/([^/]+)\/partner\.geojson$/.exec(file)?.[1] ?? null
}

/**
 * Manifest key prefix of the drag finding (WS2 session 4): haul.drag.flat.* for the default
 * scenario's partner file, haul.drag.flat.{scenario}.* for the others.
 */
export function dragKeyPrefix(file: string, defaultFile: string | null): string {
  if (file === defaultFile) return 'haul.drag.flat'
  // D21 parking option: scenarios/pads/{id}/partner.geojson -> pads.{id}.haul.drag.flat (C 16:17).
  const pad = /(?:^|\/)scenarios\/pads\/([^/]+)\/partner\.geojson$/.exec(file)?.[1]
  if (pad) return `pads.${pad}.haul.drag.flat`
  const sid = partnerScenarioId(file)
  return sid ? `haul.drag.flat.${sid}` : 'haul.drag.flat'
}

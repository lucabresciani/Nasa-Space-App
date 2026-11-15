// D20 (user 2026-11-14 14:22, SPEC F10): the drag case is a finding, never a line. The note text
// comes from the data (card / partner.geojson), else config/haul.yaml drag_note; its numbers come
// from partner.geojson `drag_finding` and the manifest (haul.drag.flat.*), never from this file.
import { CONFIG } from '../config'
import { dragFinding, dragKeyPrefix } from '../data/partner'
import type { PartnerFC } from '../data/types'
import { Num } from './Num'

export function DragNote({ fc, file, defaultFile, note }: { fc: PartnerFC | null; file: string | null; defaultFile: string | null; note?: string | null }) {
  const d = dragFinding(fc)
  const text = note || d?.note || CONFIG.haulDragNote
  if (!d || !file) {
    return (
      <p class="drag-note">
        <b>{text}</b> <span class="muted">(drag numbers not in this data tree)</span>
      </p>
    )
  }
  const k = dragKeyPrefix(file, defaultFile)
  return (
    <p class="drag-note">
      <b>{text}</b> On flat ground the pull needed is <Num v={d.force_N} units="N" file={file} k={`${k}.force_N`} />, the boot-traction limit is{' '}
      <Num v={d.traction_limit_N} units="N" file={file} k={`${k}.traction_limit_N`} />; the heaviest suited crewmate one astronaut could drag is{' '}
      <Num v={d.max_mass_kg} units="kg" file={file} k={`${k}.max_mass_kg`} />. <span class="muted">Dragging is reported as this finding and not drawn.</span>
    </p>
  )
}

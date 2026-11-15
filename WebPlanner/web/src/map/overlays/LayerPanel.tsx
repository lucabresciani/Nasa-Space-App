// WS16 task 11 (M11, U7): the layer manager (left rail, A4 registerRailSection). Groups Terrain /
// Science / Evidence; per layer a toggle, an opacity slider (tokens overlayOpacity), the trust chip,
// the one-line "what am I looking at" and the legend (shown while the layer is on). Highlight layers
// carry the "preliminary" tag in the header and in every legend row (D87). Cap notice per U7.
import { useSignalValue } from '../../state/signal'
import { Slider, Tag, Toggle, TrustChip } from '../../ui/components'
import { t } from '../../ui/copy'
import { colorVar } from '../../ui/tokens'
import { OPACITY, OVERLAY_CFG, OVERLAY_GROUPS, overlayById, OVERLAYS, type LegendItem, type OverlayDef } from './catalog'
import { capNotice, overlayOn, overlayOpacity, setOverlay, setOverlayOpacity } from './state'
import './overlays.css'

const pct = (v: number): number => Math.round(v * 100)

export const legendText = (l: LegendItem): string => ('key' in l.label ? t(l.label.key) : l.label.text)

function LegendItemRow({ item, preliminary }: { item: LegendItem; preliminary: boolean }) {
  const sw = item.swatch === 'none' ? 'hl-swatch hl-swatch--none' : `hl-swatch hl-swatch--${item.swatch === 'dashed' ? 'dashed' : item.swatch}${item.heavy ? ' hl-swatch--heavy' : ''}`
  return (
    <li class="hl-legend-row hl-ovl__legend-row">
      <span class={sw} style={item.color ? { '--sw': colorVar(item.color) } : undefined} aria-hidden="true" />
      <span class="hl-legend-row__label">{legendText(item)}</span>
      {preliminary && <Tag kind="preliminary" />}
    </li>
  )
}

function OverlayRow({ o }: { o: OverlayDef }) {
  const on = useSignalValue(overlayOn)[o.id]
  const op = useSignalValue(overlayOpacity)[o.id]
  const name = t(o.name)
  return (
    <li class="hl-ovl__layer" data-overlay={o.id} data-chip={o.chip} data-preliminary={o.preliminary ? 'true' : undefined}>
      <div class="hl-ovl__head">
        <Toggle label={name} checked={on} onChange={(v) => setOverlay(o.id, v)} />
        <TrustChip kind={o.chip} />
        {o.preliminary && <Tag kind="preliminary" />}
      </div>
      {/* the one-line "what am I looking at"; skipped when a legend row already says it (mineral caption) */}
      {!o.legend.some((l) => legendText(l) === t(o.what)) && <p class="hl-ovl__what">{t(o.what)}</p>}
      <ul class="hl-ovl__legend" role="list" aria-label={name}>
        {o.legend.map((l) => (
          <LegendItemRow item={l} preliminary={o.preliminary} />
        ))}
      </ul>
      {on && (
        <>
          <Slider label={name} min={pct(OPACITY.min)} max={pct(OPACITY.max)} step={pct(OPACITY.step)} value={pct(op)} units="%" onChange={(v) => setOverlayOpacity(o.id, v / 100)} />
        </>
      )}
    </li>
  )
}

export function LayerPanel() {
  const on = useSignalValue(overlayOn)
  const notice = useSignalValue(capNotice)
  const any = OVERLAYS.some((o) => on[o.id])
  return (
    <div class="hl-ovl">
      <p class="hl-ovl__notice" role="status">
        {notice ? t('tooltips.layerCap', { max: OVERLAY_CFG.maxThematicOn, layer: t(overlayById(notice.turnedOff).name) }) : any ? '' : t('states.empty.noLayers')}
      </p>
      {OVERLAY_GROUPS.map((g) => (
        <section class="hl-ovl__group" data-group={g}>
          <h3 class="hl-ovl__group-title">{t(`layers.groups.${g}`)}</h3>
          <ul class="hl-ovl__layers" role="list">
            {OVERLAYS.filter((o) => o.group === g).map((o) => (
              <OverlayRow o={o} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

// "Maps" switcher (bottom left of the Mission Planer map, PDF "Maps" button): Satellite (HiRISE
// basemap), Topography (hillshade + contours) and Material composition (rock units inferred from
// elevation). Rasters are rendered once per type on first use, on the routing grid.
import { useEffect, useRef, useState } from 'preact/hooks'
import type { FieldGrid } from '../hud/fields'
import type { MapType, MissionMap } from './missionMap'
import type { LonLat } from './plan'
import { renderRelief, unitBands, UNITS_FILE, type Relief, type Unit } from './relief'

const TYPES: { id: MapType; label: string; swatch: string }[] = [
  { id: 'satellite', label: 'Satellite', swatch: 'linear-gradient(135deg, #8a5a3c, #c79a6b 55%, #5c3a28)' },
  { id: 'topo', label: 'Topography', swatch: 'repeating-radial-gradient(circle at 30% 70%, #4e3c2c 0 5px, #e2d6c4 5px 6px)' },
  { id: 'material', label: 'Material', swatch: 'linear-gradient(180deg, #b394e6 0 33%, #5e93d9 33% 66%, #8fa6bf 66%)' },
]

export interface ReliefSource {
  grid: FieldGrid
  elev: Float32Array
  resM: number
  hasBasemap: boolean
}

async function toBlobUrl(r: Relief): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = r.width
  canvas.height = r.height
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.width, r.height), 0, 0)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) throw new Error('could not encode the relief image')
  return URL.createObjectURL(blob)
}

export function MapsControl({ mmap, src }: { mmap: MissionMap; src: ReliefSource }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<MapType>(src.hasBasemap ? 'satellite' : 'topo')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [relief, setRelief] = useState<Partial<Record<MapType, Relief>>>({})
  const [units, setUnits] = useState<Unit[]>([])
  const seq = useRef(0)

  useEffect(() => {
    const s = ++seq.current
    void (async () => {
      setError(null)
      if (type === 'satellite') return mmap.setMapType('satellite')
      let r = relief[type]
      if (!r) {
        setBusy(true)
        await new Promise((res) => setTimeout(res, 20)) // let "Rendering…" paint
        try {
          const { grid, elev, resM } = src
          let lo = Infinity
          let hi = -Infinity
          for (const v of elev) if (Number.isFinite(v)) (lo = Math.min(lo, v)), (hi = Math.max(hi, v))
          const u = type === 'material' ? unitBands(lo, hi) : null
          r = renderRelief(elev, grid.width, grid.height, resM, type, u)
          if (u) setUnits(u)
          setRelief((x) => ({ ...x, [type]: r }))
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          setBusy(false)
          return
        }
      }
      if (s !== seq.current) return
      const g = src.grid
      const corners: [LonLat, LonLat, LonLat, LonLat] = [
        [g.w, g.n],
        [g.e, g.n],
        [g.e, g.s],
        [g.w, g.s],
      ]
      await mmap.setRelief(await toBlobUrl(r), corners)
      await mmap.setMapType(type)
      setBusy(false)
    })()
  }, [type])

  const cur = TYPES.find((t) => t.id === type)!
  const r = relief[type]
  return (
    <div class="mp-maps">
      {busy && <div class="mp-maps-legend">Rendering {cur.label.toLowerCase()}…</div>}
      {error && <div class="mp-maps-legend mp-bad">{error}</div>}
      {!busy && r && type === 'topo' && (
        <div class="mp-maps-legend">
          Contours every {r.contourM} m (bold every {r.contourM * 5} m) · {Math.round(r.minE)} to {Math.round(r.maxE)} m (MOLA areoid), 8 m terrain heights
        </div>
      )}
      {!busy && r && type === 'material' && <MaterialLegend r={r} units={units} />}
      {open && (
        <div class="mp-maps-menu" role="menu">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === type}
              class={`mp-maps-tile${t.id === type ? ' on' : ''}`}
              disabled={t.id === 'satellite' && !src.hasBasemap}
              title={t.id === 'satellite' && !src.hasBasemap ? 'No basemap tiles in this data tree' : undefined}
              onClick={() => {
                setType(t.id)
                setOpen(false)
              }}
            >
              <span class="mp-maps-swatch" style={{ background: t.swatch }} />
              {t.label}
            </button>
          ))}
        </div>
      )}
      <button type="button" class="mp-maps-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Change the map type">
        <span class="mp-maps-swatch" style={{ background: cur.swatch }} />
        <span>
          <b>Maps</b>
          <br />
          {cur.label}
        </span>
      </button>
    </div>
  )
}

function MaterialLegend({ r, units }: { r: Relief; units: Unit[] }) {
  const shown = units.filter((u) => (r.unitCells.get(u.id) ?? 0) > 0).sort((a, b) => a.lo - b.lo)
  return (
    <div class="mp-maps-legend">
      <b>Rock unit, inferred from elevation</b>
      <ul>
        {shown.length ? (
          shown.map((u) => (
            <li key={u.id} title={`${u.name}: Curiosity samples from ${Math.round(u.lo)} to ${Math.round(u.hi)} m`}>
              <span class="mp-swatch" style={{ background: `rgb(${u.rgb.join(',')})` }} />
              {u.label}
            </li>
          ))
        ) : (
          <li>No unit band reaches this terrain.</li>
        )}
        <li title="Heights above or below every Curiosity sample in the database (it ends at sol 3712, before the boxwork region)">
          <span class="mp-swatch" style={{ background: 'rgb(70,70,70)' }} />
          Grey: no sample at that height
        </li>
      </ul>
      <span class="mp-maps-note" title={UNITS_FILE.rule}>
        Mount Sharp's layers are nearly flat, so each unit is drawn at the heights where Curiosity sampled it (± {UNITS_FILE.band_margin_m} m, fading beyond).
        Not a mineral survey. Data: Curiosity APXS (PDS), via the team's Unity rock database.
      </span>
    </div>
  )
}

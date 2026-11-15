// WS16 task 2 (M2): load and decode the inputs of the field layer for one suit mass (browser).
// t_home for opt/nom/con, o2_home nominal (fields/index.json), and the cell-state grid
// (terrain/cellstate.json, optional). Decoded once per suit mass and shared by the GPU layer and
// fieldAt().
import { data } from '../../data/loader'
import { dataUrl } from '../../env'
import { fieldGrid, loadFieldRGBA } from '../../hud/fields'
import { VARIANTS, type Variant } from './constants'
import { decodeGrid, decodeState, FieldData, type Bounds, type DecodedGrid, type StateGrid } from './decode'

const cache = new Map<number, Promise<FieldData>>()

export function loadFieldData(suitKg: number): Promise<FieldData> {
  let p = cache.get(suitKg)
  if (!p) {
    p = load(suitKg)
    p.catch(() => cache.delete(suitKg))
    cache.set(suitKg, p)
  }
  return p
}

async function load(suitKg: number): Promise<FieldData> {
  const L = data()
  const [fi, cs] = await Promise.all([L.fieldsIndex(), L.optional(() => L.cellstate())])
  const sources: string[] = []
  const grid = async (key: string): Promise<DecodedGrid> => {
    const meta = fi.fields[key]
    if (!meta) throw new Error(`fields/index.json has no ${key}`)
    const g = fieldGrid(fi, key)
    const { rgba, width, height } = await loadFieldRGBA(dataUrl(meta.file))
    if (width !== g.width || height !== g.height) throw new Error(`${meta.file} is ${width}x${height}, index says ${g.width}x${g.height}`)
    sources.push(meta.file)
    return decodeGrid(rgba, width, height, meta.scale, g.bounds as Bounds)
  }
  const [opt, nom, con] = await Promise.all(VARIANTS.map((v) => grid(`${v}_${suitKg}/t_home`)))
  const t: Record<Variant, DecodedGrid> = { opt, nom, con }
  const o2 = fi.fields[`nom_${suitKg}/o2_home`] ? await grid(`nom_${suitKg}/o2_home`) : null
  let state: StateGrid | null = null
  if (cs) {
    const { rgba, width, height } = await loadFieldRGBA(dataUrl(cs.image))
    if (width !== cs.width || height !== cs.height) throw new Error(`${cs.image} is ${width}x${height}, cellstate.json says ${cs.width}x${cs.height}`)
    state = decodeState(rgba, width, height, cs.bounds)
    sources.push(cs.image)
  }
  return new FieldData(suitKg, t, o2, state, sources, typeof fi.res_m === 'number' ? fi.res_m : null)
}

// Data source switch (docs/dummy.md): VITE_DATA=dummy reads data-dummy/, otherwise data/.
export type DataMode = 'dummy' | 'real'

export const DATA_MODE: DataMode = import.meta.env.VITE_DATA === 'dummy' ? 'dummy' : 'real'

export function dataDir(mode: DataMode = DATA_MODE): string {
  return mode === 'dummy' ? 'data-dummy' : 'data'
}

/**
 * URL of a data file, relative to the page (base './' + hash routing keeps this stable).
 * `base` (backend D48, F23): the root of another tree in the same contracts, e.g. a live result
 * `https://{server}/api/v1/results/{hash}`. Without it the URL is exactly the static one.
 */
export function dataUrl(path: string, mode: DataMode = DATA_MODE, base?: string): string {
  const rel = path.replace(/^\/+/, '')
  if (base) return `${base.replace(/\/+$/, '')}/${rel}`
  return `${import.meta.env.BASE_URL}${dataDir(mode)}/${rel}`
}

export const IS_DEV = import.meta.env.DEV

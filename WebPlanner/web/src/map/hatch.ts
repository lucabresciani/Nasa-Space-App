// Hatched unknowns (SPEC F1: unknown terrain stays unknown and is drawn hatched). The mask is the
// alpha channel of a field PNG (§6.1: A = 0 unknown); this only paints it, it computes nothing.

export interface HatchStyle {
  period: number // px between diagonal lines
  lineWidth: number // px
  line: [number, number, number, number]
  fill: [number, number, number, number]
}

export function hatchUnknown(alpha: ArrayLike<number>, w: number, h: number, s: HatchStyle): Uint8ClampedArray {
  if (alpha.length !== w * h) throw new Error(`alpha has ${alpha.length} cells, expected ${w * h}`)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (alpha[i] !== 0) continue
      const c = (x + y) % s.period < s.lineWidth ? s.line : s.fill
      out.set(c, i * 4)
    }
  }
  return out
}

/** Decode a PNG URL to its alpha channel via Canvas 2D (browser only). */
export async function loadAlpha(url: string): Promise<{ alpha: Uint8ClampedArray; width: number; height: number }> {
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const alpha = new Uint8ClampedArray(canvas.width * canvas.height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]
  return { alpha, width: canvas.width, height: canvas.height }
}

/** Paint the hatch to a PNG data URL for a MapLibre image source. */
export function hatchDataUrl(alpha: Uint8ClampedArray, w: number, h: number, s: HatchStyle): string {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(w, h)
  img.data.set(hatchUnknown(alpha, w, h, s))
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

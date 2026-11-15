// Minimal PNG reader for tests in Node (no browser canvas): 8-bit RGBA, non-interlaced, as WS2/WS7
// write the field PNGs. Returns the raw bytes, exactly as loadFieldRGBA does in the browser.
import { inflateSync } from 'node:zlib'

export function decodePngRGBA(buf: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!sig.every((v, i) => buf[i] === v)) throw new Error('not a PNG')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 8
  let width = 0
  let height = 0
  const idat: Uint8Array[] = []
  while (pos < buf.length) {
    const len = dv.getUint32(pos)
    const type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8))
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8)
      height = dv.getUint32(pos + 12)
      const [depth, colour, , , interlace] = data.subarray(8, 13)
      if (depth !== 8 || colour !== 6 || interlace !== 0) throw new Error(`PNG must be 8-bit RGBA, non-interlaced (got depth ${depth}, colour ${colour}, interlace ${interlace})`)
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      let p: number
      switch (f) {
        case 0: p = 0; break
        case 1: p = a; break
        case 2: p = b; break
        case 3: p = (a + b) >> 1; break
        case 4: {
          const pa = Math.abs(b - c)
          const pb = Math.abs(a - c)
          const pc = Math.abs(a + b - 2 * c)
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
        default: throw new Error(`PNG filter ${f}`)
      } // prettier-ignore
      row[x] = (src[x] + p) & 255
    }
  }
  return { rgba: out, width, height }
}

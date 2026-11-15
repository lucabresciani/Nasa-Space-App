"""Ortho texture chunks for the 3D view (WS8, F20): ``fp3d/near_tex/{i}_{j}.jpg``.

One JPEG per written near chunk, covering exactly that chunk's square (row 0 = north, column 0 =
west), ``texture.chunk_px`` pixels per side (config/fp3d.yaml). Each texel is the area mean of the
ortho over the texel. Source: WS1 ``ortho_lrgb_1m.tif`` (HiRISE LRGB mosaic, 8-bit RGB + alpha;
colour where the colour strip covers, greyscale elsewhere, as SPEC F20 asks). A texel is valid
only when every source pixel under it has alpha > 0; invalid texels get ``nodata_rgb`` (the
untextured ground colour), never invented detail. A chunk with no ortho at all gets no texture
(the client draws it untextured). Input values are 8-bit DN and clipped to 0..255.

``fp3d/far_tex.jpg`` (:func:`export_far_texture_from_file`): one JPEG over the whole far-mesh
square at ``far.texture.res_m``, same texel rule (area mean where the ortho covers the texel fully,
``nodata_rgb`` elsewhere). Row 0 = north edge of the far square, column 0 = its west edge.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from affine import Affine
from PIL import Image

from pipeline.export.terrain_chunks import FAR_TEX_FILE, TEX_DIR, ChunkGrid, resample_mean


def chunk_texture(rgb: np.ndarray, tr: Affine, grid: ChunkGrid, i: int, j: int, *, tex_px: int,
                  nodata_rgb: tuple[int, int, int] | list[int]) -> tuple[Image.Image, int]:
    """RGB texture of chunk (i, j) from a (3, H, W) float array with NaN = no data.

    Returns (image, number of no-data texels). Raises ValueError when the chunk has no ortho."""
    w, _, _, n = grid.chunk_bounds_xy(i, j)
    res = grid.size_m / tex_px
    bands = np.stack([resample_mean(rgb[b], tr, w, n, res, (tex_px, tex_px)) for b in range(3)],
                     axis=2)
    ok = np.isfinite(bands).all(axis=2)
    if not ok.any():
        raise ValueError(f"chunk {i}_{j}: no ortho")
    out = np.empty_like(bands)
    out[ok] = bands[ok]
    out[~ok] = np.asarray(nodata_rgb, dtype=float)
    img = Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8), mode="RGB")
    return img, int((~ok).sum())


def encode_jpeg(img: Image.Image, quality: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=int(quality), optimize=True)
    return buf.getvalue()


def export_textures(rgb: np.ndarray, tr: Affine, grid: ChunkGrid, chunks: list[tuple[int, int]],
                    out_dir: Path, *, tex_px: int, quality: int,
                    nodata_rgb: tuple[int, int, int] | list[int]) -> list[dict]:
    """Write ``<out_dir>/fp3d/near_tex/{i}_{j}.jpg``; returns [{i, j, tex, bytes, nodata_px}]."""
    out_dir = Path(out_dir)
    (out_dir / TEX_DIR).mkdir(parents=True, exist_ok=True)
    out = []
    for i, j in chunks:
        try:
            img, nod = chunk_texture(rgb, tr, grid, i, j, tex_px=tex_px, nodata_rgb=nodata_rgb)
        except ValueError:
            continue
        rel = f"{TEX_DIR}/{i}_{j}.jpg"
        data = encode_jpeg(img, quality)
        (out_dir / rel).write_bytes(data)
        out.append({"i": i, "j": j, "tex": rel, "bytes": len(data), "nodata_px": nod})
    return out


def read_rgba(path: Path, grid: ChunkGrid, chunks: list[tuple[int, int]], margin_px: int = 2
              ) -> tuple[np.ndarray, Affine]:
    """Read the window of an RGB(+alpha) ortho covering ``chunks`` as (3, H, W) float32 with NaN
    where alpha == 0 (or the RGB nodata value). Pixels outside the file are NaN."""
    xs = [grid.chunk_bounds_xy(i, j) for i, j in chunks]
    return read_rgba_bounds(path, min(b[0] for b in xs), min(b[1] for b in xs),
                            max(b[2] for b in xs), max(b[3] for b in xs), margin_px)


def read_rgba_bounds(path: Path, w: float, s: float, e: float, n: float, margin_px: int = 2
                     ) -> tuple[np.ndarray, Affine]:
    """:func:`read_rgba` for a box (w, s, e, n) in the ortho's CRS."""
    import rasterio
    from rasterio.windows import from_bounds

    with rasterio.open(path) as ds:
        win = from_bounds(w, s, e, n, ds.transform).round_offsets().round_lengths()
        win = rasterio.windows.Window(win.col_off - margin_px, win.row_off - margin_px,
                                      win.width + 2 * margin_px, win.height + 2 * margin_px)
        a = ds.read(window=win, boundless=True, fill_value=0, masked=False)
        tr = ds.window_transform(win)
        rgb = a[:3].astype(np.float32)
        if ds.count >= 4:
            bad = a[3] == 0
        elif ds.nodata is not None:
            bad = (a[:3] == ds.nodata).all(axis=0)
        else:
            bad = np.zeros(a.shape[1:], dtype=bool)
        rgb[:, bad] = np.nan
    return rgb, tr


def export_textures_from_file(path: Path, grid: ChunkGrid, chunks: list[tuple[int, int]],
                              out_dir: Path, *, tex_px: int, quality: int,
                              nodata_rgb: tuple[int, int, int] | list[int]) -> list[dict]:
    """Per chunk: read its window of the ortho (bounded memory) and write the texture."""
    out = []
    for ij in chunks:
        rgb, tr = read_rgba(path, grid, [ij])
        out += export_textures(rgb, tr, grid, [ij], out_dir, tex_px=tex_px, quality=quality,
                               nodata_rgb=nodata_rgb)
    return out


def far_texture_from_file(path: Path, fgrid: ChunkGrid, *, res_m: float,
                          nodata_rgb: tuple[int, int, int] | list[int], strip_rows: int = 128
                          ) -> tuple[np.ndarray, int]:
    """(rows, cols, 3) uint8 texture of the far square ``fgrid`` (see far_mesh.far_grid) at
    ``res_m`` per texel, row 0 = north, and its number of no-data texels. Strips of
    ``strip_rows`` texel rows bound the memory."""
    n_px = int(round(fgrid.extent_m / res_m))
    if abs(n_px * res_m - fgrid.extent_m) > 1e-6:
        raise ValueError(f"far texture res {res_m} m does not divide the far extent "
                         f"{fgrid.extent_m} m")
    img = np.empty((n_px, n_px, 3))
    ok = np.zeros((n_px, n_px), dtype=bool)
    for r0 in range(0, n_px, strip_rows):
        r1 = min(n_px, r0 + strip_rows)
        north = fgrid.y0 - r0 * res_m
        south = fgrid.y0 - r1 * res_m
        rgb, tr = read_rgba_bounds(path, fgrid.x0, south, fgrid.x0 + fgrid.extent_m, north)
        bands = np.stack([resample_mean(rgb[b], tr, fgrid.x0, north, res_m, (r1 - r0, n_px))
                          for b in range(3)], axis=2)
        img[r0:r1] = bands
        ok[r0:r1] = np.isfinite(bands).all(axis=2)
    img[~ok] = np.asarray(nodata_rgb, dtype=float)
    return np.clip(np.round(img), 0, 255).astype(np.uint8), int((~ok).sum())


def export_far_texture_from_file(path: Path, fgrid: ChunkGrid, out_dir: Path, *, res_m: float,
                                 quality: int, nodata_rgb: tuple[int, int, int] | list[int],
                                 strip_rows: int = 128) -> dict:
    """Write ``<out_dir>/fp3d/far_tex.jpg`` (:func:`far_texture_from_file`). Returns the
    index.json ``far`` keys ``tex``, ``tex_res_m``, ``tex_width``, ``tex_height``,
    ``tex_bytes``, ``tex_nodata_px``."""
    img, nod = far_texture_from_file(path, fgrid, res_m=res_m, nodata_rgb=nodata_rgb,
                                     strip_rows=strip_rows)
    n_px = img.shape[0]
    data = encode_jpeg(Image.fromarray(img, mode="RGB"), quality)
    out = Path(out_dir) / FAR_TEX_FILE
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return {"tex": FAR_TEX_FILE, "tex_res_m": float(res_m), "tex_width": n_px,
            "tex_height": n_px, "tex_bytes": len(data), "tex_nodata_px": nod}

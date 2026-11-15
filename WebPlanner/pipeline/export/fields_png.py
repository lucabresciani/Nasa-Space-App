"""Field PNG export for the live HUD (F18, F19; SPEC §6.1; contracts/README.md "Field PNGs").

Encoding (contracts v1.1.0, ``config/hud.yaml`` ``field_png`` / ``field_scales``): one 8-bit RGBA
PNG per field; counts = round(value / scale) (round half to even, as ``np.rint``),
R = counts >> 8, G = counts & 255, B = 0, A = 255 valid / 0 unknown. Physical value =
counts × scale, ``scale`` (units per count) listed in ``fields/index.json``. The TypeScript decoder
is ``web/src/hud/fields.ts`` and must stay bit-identical to ``decode_rgba`` here.
Non-finite input (NaN, ±inf) is unknown. Values outside 0..65535 counts are refused unless
``clip=True``: a silently clipped T_home would be a wrong number on the HUD.

Grid: every field PNG is on the one index grid, WS1's ``fields_5m`` grid in
``data/interim/terrain/grid.json`` (pad ± ``planning_radius_m`` at ``field_png.res_m``; the pad is a
pixel corner). Inputs on other grids are *sampled*, never interpolated:

* WS2 ``t_home`` / ``o2_home`` (3 m route grid): each 5 m pixel takes the 3 m cell under its
  centre (nearest neighbour; on the real grids the 5 m centres sit at pad + 2.5 + 5k m and the
  3 m edges at pad + 3j m, so a centre never lies on a cell edge). Were it ever on an edge, the
  pixel takes the max of the known tied cells (the conservative value). ``sample_centres``.
* WS1 ``slope_5m.tif`` (5 m-window slope posted at 1 m): the 1 m cell whose 5 × 5 window is the
  5 m pixel (the centre cell, offset 2 of 5). ``sample_centres`` with the 1 m grid.
* ``home_bearing``: the geometric bearing (clockwise from grid north) from the pixel centre to the
  pad in use, in the analysis CRS; known everywhere on the grid. The pad in use is WS2's
  ``engine/public/pad.json`` ``pad`` (the D21 official pad; contract pad v1.1.2), projected with
  the grid's own ``crs``; only without pad.json does it fall back to ``grid.json`` pad
  (``pad_default``, which only anchors the grid). The run report says which (``rep["pad"]``) and
  the manifest records ``fields.{sc}/home_bearing.pad_lon`` / ``.pad_lat``.
* worst-case fields (``pipeline/export/worstcase.py``): the disc max is taken on WS2's native 3 m
  grid (radius rounded up to whole cells) and then sampled with the same rule as the point field,
  so worst ≥ point pixel by pixel.

CLI (``make fields``): ``python -m pipeline.export.fields_png [--scenarios ...] [--dry-run]``
reads ``data/interim/{terrain,engine}/`` and writes ``data/interim/export/fields/`` (the
``make web`` source, contracts/README.md "make web sources"). Missing inputs are skipped and
reported by owner, never faked. WS9's ``data/interim/navigation/fields_index_nav.json``
(``fix_interval_{set}`` entries; the PNGs reach the web tree through WS9's own ``make web`` rule)
is merged into ``fields/index.json`` when its grid is exactly this one (``merge_nav_index``).
Every scenario's way-home pointer (WS2 ``engine/{sc}/pointer.tif``) is written as
``fields/{sc}/pointer.png`` on WS2's native 3 m route grid, with its own ``bounds``/
``width``/``height``/``res_m`` and the ``stencil`` in its index entry (contracts v1.1.1;
``--no-pointer`` skips it).

Provenance (AGENTS.md rule 6): per PNG, ``fields.<key>.sha256`` (the file, which backs every
per-pixel value the HUD reads from it), ``fields.<key>.max`` and ``fields.<key>.known_pct``.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from PIL import Image

from pipeline.export import worstcase

MAX_COUNTS = 65535  # 16 bits in R (high byte) and G (low byte)
SCRIPT = __file__
REPO = Path(__file__).resolve().parents[2]
CONFIG = REPO / "config"
INTERIM = REPO / "data" / "interim"
OUT_REL = Path("export")  # data/interim/export/fields/... (make web source)

_WORST_RE = re.compile(r"^(?P<base>.+)_worst_\d+$")
CATEGORICAL_UNITS = frozenset({"move"})
POINTER_NONE = -1  # WS2 pointer.tif: int8 move index, -1 = pad or unreached


# ------------------------------------------------------------------------- encode / decode ----
def _as_float(values: np.ndarray) -> np.ndarray:
    v = np.asarray(values, dtype=np.float64)
    if v.ndim != 2:
        raise ValueError(f"field must be a 2-D array, got shape {v.shape}")
    return v


def encode_counts(values: np.ndarray, scale: float, *, clip: bool = False):
    """Return ``(counts uint16, valid bool)`` for a 2-D field."""
    if not scale > 0:
        raise ValueError(f"scale must be > 0, got {scale!r}")
    v = _as_float(values)
    valid = np.isfinite(v)
    q = np.zeros(v.shape, dtype=np.float64)
    q[valid] = np.rint(v[valid] / scale)
    if clip:
        q = np.clip(q, 0, MAX_COUNTS)
    else:
        bad = valid & ((q < 0) | (q > MAX_COUNTS))
        if bad.any():
            lo, hi = float(np.min(v[valid])), float(np.max(v[valid]))
            raise ValueError(
                f"{int(bad.sum())} cells outside 0..{MAX_COUNTS} counts at scale {scale} "
                f"(range {lo:g}..{hi:g}); pass clip=True only if clipping is intended"
            )
    return q.astype(np.uint16), valid


def encode_rgba(values: np.ndarray, scale: float, *, clip: bool = False) -> np.ndarray:
    """2-D field -> (H, W, 4) uint8 RGBA per the contract."""
    counts, valid = encode_counts(values, scale, clip=clip)
    rgba = np.zeros(counts.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = np.where(valid, counts >> 8, 0)
    rgba[..., 1] = np.where(valid, counts & 255, 0)
    rgba[..., 3] = np.where(valid, 255, 0)
    return rgba


def encode_png(values: np.ndarray, scale: float, *, clip: bool = False,
               compress_level: int = 6) -> bytes:
    """2-D field -> PNG bytes (8-bit RGBA, no colour-space chunks)."""
    buf = io.BytesIO()
    Image.fromarray(encode_rgba(values, scale, clip=clip), "RGBA").save(
        buf, format="PNG", compress_level=compress_level
    )
    return buf.getvalue()


def decode_rgba(rgba: np.ndarray, scale: float) -> np.ndarray:
    """(H, W, 4) uint8 RGBA -> float64 field; NaN where A = 0 (unknown)."""
    a = np.asarray(rgba)
    if a.ndim != 3 or a.shape[2] != 4:
        raise ValueError(f"expected (H, W, 4) RGBA, got {a.shape}")
    counts = a[..., 0].astype(np.int64) * 256 + a[..., 1].astype(np.int64)
    out = counts * float(scale)
    out[a[..., 3] == 0] = np.nan
    return out


def decode_png(data: bytes | str | Path, scale: float) -> np.ndarray:
    """PNG bytes or path -> float64 field; NaN where unknown."""
    src = io.BytesIO(data) if isinstance(data, bytes) else Path(data)
    with Image.open(src) as img:
        if img.mode != "RGBA":
            raise ValueError(f"field PNG must be RGBA, got {img.mode}")
        return decode_rgba(np.asarray(img), scale)


def field_scale(name: str, hud_cfg: Mapping[str, Any]) -> tuple[float, str]:
    """``(per_count, units)`` for a field name from ``config/hud.yaml`` ``field_scales``.

    ``t_home_worst_50`` uses the ``t_home`` scale; ``fix_interval_{set}`` uses ``fix_interval``.
    ``pointer`` (``--with-pointer`` proposal only) is a move index: 1 count = 1 move.
    """
    if name == "pointer":
        return 1, "move"
    scales = hud_cfg["field_scales"]
    base = name
    m = _WORST_RE.match(name)
    if m:
        base = m.group("base")
    elif name.startswith("fix_interval_"):
        base = "fix_interval"
    if base not in scales:
        raise KeyError(f"no field scale for {name!r} in config/hud.yaml field_scales")
    s = scales[base]
    return s["per_count"], s["units"]


# -------------------------------------------------------------------------------- sampling ----
def _axis_cells(offset_m: float, dst_res: float, n: int, src_res: float, n_src: int):
    """Source cell index pair (lo, hi) under each target pixel centre along one axis.

    ``offset_m`` = target leading edge minus source leading edge (metres east, or south).
    lo == hi unless the centre falls exactly on a source cell edge; -1 / n_src = outside.
    """
    u = (offset_m + (np.arange(n) + 0.5) * dst_res) / src_res
    eps = 1e-9
    lo = np.floor(u - eps).astype(np.int64)
    hi = np.floor(u + eps).astype(np.int64)
    lo = np.where(lo == hi - 1, lo, hi)  # tie only when u is (numerically) an integer
    return np.clip(lo, -1, n_src), np.clip(hi, -1, n_src)


def sample_centres(src: np.ndarray, src_nw: Sequence[float], src_res: float,
                   dst_nw: Sequence[float], dst_res: float,
                   dst_shape: tuple[int, int]) -> np.ndarray:
    """Sample ``src`` at the target pixel centres (see the module docstring); NaN = unknown.

    ``*_nw`` = (x, y) of the north-west pixel corner in the same metric CRS (x east, y north).
    A centre on a source cell edge takes the max of the known tied cells; a centre outside the
    source is unknown.
    """
    s = np.asarray(src, dtype=np.float64)
    hs, ws = s.shape
    clo, chi = _axis_cells(dst_nw[0] - src_nw[0], dst_res, dst_shape[1], src_res, ws)
    rlo, rhi = _axis_cells(src_nw[1] - dst_nw[1], dst_res, dst_shape[0], src_res, hs)
    pad = np.full((hs + 2, ws + 2), np.nan)  # index -1 and n_src -> NaN (outside)
    pad[1:-1, 1:-1] = s
    out = np.full(dst_shape, -np.inf)
    seen_known = np.zeros(dst_shape, dtype=bool)
    for rr in (rlo, rhi):
        for cc in (clo, chi):
            v = pad[(rr + 1)[:, None], (cc + 1)[None, :]]
            k = np.isfinite(v)
            out = np.where(k, np.maximum(out, v), out)
            seen_known |= k
    out[~seen_known] = np.nan
    return out


def _grid_transformers(grid: Mapping[str, Any]):
    """(lon/lat -> xy, xy -> lon/lat) for the grid's analysis CRS on its own sphere (``+R=``)."""
    from pyproj import Transformer

    crs = str(grid["crs"])
    m = re.search(r"\+R=([0-9.eE+-]+)", crs)
    if not m:
        raise ValueError(f"grid.json crs has no +R= sphere radius: {crs!r}")
    geo = f"+proj=longlat +R={m.group(1)} +no_defs"
    return (Transformer.from_crs(geo, crs, always_xy=True),
            Transformer.from_crs(crs, geo, always_xy=True))


def lonlat_to_grid_xy(grid: Mapping[str, Any], lon: float, lat: float) -> tuple[float, float]:
    """Analysis-CRS xy (m) of a lon/lat (deg, planetocentric) in the grid.json ``crs``."""
    x, y = _grid_transformers(grid)[0].transform(lon, lat)
    return float(x), float(y)


def grid_lonlat_of_xy(grid: Mapping[str, Any], x: float, y: float) -> tuple[float, float]:
    """Inverse of ``lonlat_to_grid_xy``."""
    lon, lat = _grid_transformers(grid)[1].transform(x, y)
    return float(lon), float(lat)


def pad_in_use(interim: Path, grid: Mapping[str, Any]) -> dict[str, Any]:
    """The pad home_bearing aims at: WS2's pad.json ``pad`` (D21), else grid.json's pad."""
    pj = interim / "engine" / "public" / "pad.json"
    if pj.exists():
        p = json.loads(pj.read_text())["pad"]
        lon, lat = float(p["lon"]), float(p["lat"])
        return {"lon": lon, "lat": lat, "xy": list(lonlat_to_grid_xy(grid, lon, lat)),
                "source": "engine/public/pad.json pad"}
    g = grid["pad"]
    return {"lon": g.get("lon"), "lat": g.get("lat"), "xy": [float(v) for v in g["xy"]],
            "source": "terrain/grid.json pad"}


def home_bearing_deg(nw: Sequence[float], res: float, shape: tuple[int, int],
                     pad_xy: Sequence[float]) -> np.ndarray:
    """Bearing (deg, clockwise from grid north, 0..360) from each pixel centre to the pad."""
    h, w = shape
    x = nw[0] + (np.arange(w) + 0.5) * res
    y = nw[1] - (np.arange(h) + 0.5) * res
    dx = pad_xy[0] - x[None, :]
    dy = pad_xy[1] - y[:, None]
    b = np.degrees(np.arctan2(dx, dy)) % 360.0
    # 360.0 after rounding would be 36000 counts: fold onto 0
    return np.where(np.rint(b / 0.01) >= 36000, 0.0, b)


# ------------------------------------------------------------------------ writing + index ----
def write_field(
    out_root: str | Path,
    key: str,
    values: np.ndarray,
    scenario: str | None,
    hud_cfg: Mapping[str, Any],
    *,
    file_key: str | None = None,
    clip: bool = False,
    extra: Mapping[str, Any] | None = None,
    record_manifest: bool = True,
    manifest_fragment_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Encode one field to ``<out_root>/fields/<file_key or key>.png``; return its index entry.

    ``key`` is the index key (``nom_104/t_home``, ``slope``); ``file_key`` the path under
    ``fields/`` without ``.png`` when it differs (``shared/slope``). The field name used for the
    scale is the key's last component.
    """
    v = _as_float(values)
    name = key.rsplit("/", 1)[-1]
    scale, units = field_scale(name, hud_cfg)
    rel = f"fields/{file_key or key}.png"
    path = Path(out_root) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    data = encode_png(v, scale, clip=clip, compress_level=9)
    path.write_bytes(data)
    if record_manifest:
        from pipeline.provenance.manifest import record

        record(f"fields.{key}.sha256", hashlib.sha256(data).hexdigest(), "sha256", rel, SCRIPT,
               fragment_dir=manifest_fragment_dir)
        decoded = decode_png(data, scale)
        known = decoded[np.isfinite(decoded)]
        record(f"fields.{key}.known_pct", round(100.0 * known.size / decoded.size, 2), "%",
               rel, SCRIPT, fragment_dir=manifest_fragment_dir)
        if units not in CATEGORICAL_UNITS:
            vmax = round(float(known.max()), 6) if known.size else None
            record(f"fields.{key}.max", vmax, units, rel, SCRIPT,
                   fragment_dir=manifest_fragment_dir)
    return {"file": rel, "scale": scale, "units": units, "scenario": scenario,
            **(extra or {})}


def build_index(bounds: Sequence[float], width: int, height: int, res_m: float,
                fields: Mapping[str, Mapping[str, Any]], *, dummy: bool) -> dict[str, Any]:
    """``fields/index.json`` per ``contracts/fields_index.schema.json`` (validated here)."""
    from jsonschema import Draft202012Validator

    idx = {
        "dummy": bool(dummy),
        "bounds": [round(float(b), 6) for b in bounds],
        "width": int(width),
        "height": int(height),
        "res_m": res_m,
        "fields": {k: dict(v) for k, v in sorted(fields.items())},
    }
    schema = json.loads((REPO / "contracts" / "fields_index.schema.json").read_text())
    Draft202012Validator(schema).validate(idx)
    return idx


# ------------------------------------------------------ way-home pointer (contracts v1.1.1) ----
def pointer_values(pointer: np.ndarray, n_moves: int) -> np.ndarray:
    """WS2 ``pointer.tif`` (int move index, -1 = no move) -> float field, NaN = no move."""
    p = np.asarray(pointer)
    if p.ndim != 2:
        raise ValueError(f"pointer must be 2-D, got shape {p.shape}")
    pi = p.astype(np.int64)
    none = pi == POINTER_NONE
    bad = ~none & ((pi < 0) | (pi >= n_moves))
    if bad.any():
        raise ValueError(f"{int(bad.sum())} pointer cells hold no valid move index "
                         f"(0..{n_moves - 1} or {POINTER_NONE})")
    out = pi.astype(np.float64)
    out[none] = np.nan
    return out


def follow_pointer(values: np.ndarray, stencil: Sequence[Sequence[int]], row: int, col: int,
                   max_steps: int | None = None) -> tuple[list[tuple[int, int]], str]:
    """Follow a pointer field from (row, col): ``(pixels incl. the start, reason)``.

    reason: ``stop`` (a cell with no move: the pad, unreached or unknown), ``outside``,
    ``cycle`` (never in a valid field), ``limit``. Reference for ``web/src/hud/wayhome.ts``.
    """
    v = np.asarray(values, dtype=np.float64)
    h, w = v.shape
    limit = h * w if max_steps is None else int(max_steps)
    path = [(int(row), int(col))]
    seen = {path[0]}
    r, c = path[0]
    for _ in range(limit):
        x = v[r, c]
        if not np.isfinite(x):
            return path, "stop"
        dr, dc = stencil[int(x)]
        r, c = r + int(dr), c + int(dc)
        if not (0 <= r < h and 0 <= c < w):
            return path, "outside"
        if (r, c) in seen:
            return path, "cycle"
        seen.add((r, c))
        path.append((r, c))
    return path, "limit"


# ---------------------------------------------------------------------------------- CLI ----
def _load_yaml(name: str) -> dict:
    return yaml.safe_load((CONFIG / name).read_text())


def _read_tif(path: Path) -> tuple[np.ndarray, tuple[float, float], float]:
    """Band 1 as float64 (nodata -> NaN), NW corner (x, y), square cell size."""
    import rasterio

    with rasterio.open(path) as ds:
        a = ds.read(1).astype(np.float64)
        t = ds.transform
        if abs(t.b) > 0 or abs(t.d) > 0 or not math.isclose(t.a, -t.e):
            raise ValueError(f"{path}: not a north-up square-pixel raster")
        if ds.nodata is not None and np.isfinite(ds.nodata):
            a[a == ds.nodata] = np.nan
    return a, (t.c, t.f), float(t.a)


NAV_INDEX = Path("navigation") / "fields_index_nav.json"  # WS9, pipeline/navigation/real.py


def merge_nav_index(entries: dict[str, dict[str, Any]], grid: Mapping[str, Any],
                    nav_idx: Mapping[str, Any], nav_root: Path) -> tuple[list[str], str | None]:
    """Add WS9's ``fix_interval_{set}`` entries to ``entries`` if WS9's grid is this grid.

    ``grid`` = ``{bounds, width, height, res_m}`` of the index. Returns ``(keys added, refusal)``;
    a refusal (grid mismatch, unexpected key or file, PNG absent) adds nothing.
    """
    for k in ("width", "height"):
        if int(nav_idx.get(k, -1)) != int(grid[k]):
            return [], f"WS9 grid {k} {nav_idx.get(k)} != {grid[k]}"
    if not math.isclose(float(nav_idx.get("res_m", -1)), float(grid["res_m"])):
        return [], f"WS9 grid res_m {nav_idx.get('res_m')} != {grid['res_m']}"
    nb = nav_idx.get("bounds") or []
    if len(nb) != 4 or any(abs(float(a) - float(b)) > 1e-6
                           for a, b in zip(nb, grid["bounds"], strict=True)):
        return [], f"WS9 grid bounds {nb} != {list(grid['bounds'])}"
    add: dict[str, dict[str, Any]] = {}
    for k, e in (nav_idx.get("fields") or {}).items():
        if not re.fullmatch(r"fix_interval_\w+", k) or e.get("file") != f"fields/{k}.png":
            return [], f"WS9 entry {k!r} is not fix_interval_{{set}} -> fields/{k}.png"
        if not (nav_root / e["file"]).exists():
            return [], f"WS9 entry {k}: {e['file']} missing under {nav_root}"
        add[k] = {kk: e[kk] for kk in ("file", "scale", "units", "scenario")}
    entries.update(add)
    return sorted(add), None


def _lonlat_bounds(grid5: Mapping[str, Any]) -> list[float]:
    return [round(float(b), 6) for b in grid5["bounds_lonlat"]]


def run(*, interim: str | Path = INTERIM, out_root: str | Path | None = None,
        scenarios: Sequence[str] | None = None, dry_run: bool = False,
        with_pointer: bool = True, manifest_fragment_dir: str | Path | None = None,
        log: Callable[..., None] = print) -> dict[str, Any]:
    """Export every field whose inputs exist; returns ``{written, skipped, inputs, sizes}``."""
    interim = Path(interim)
    out_root = Path(out_root) if out_root is not None else interim / OUT_REL
    hud = _load_yaml("hud.yaml")
    variants = _load_yaml("variants.yaml")
    ids = list(scenarios) if scenarios else list(variants["scenarios"]["ids"])
    worst_sc = variants["scenarios"]["default"]
    radii = hud["worst_case_radii_m"]

    grid_json = interim / "terrain" / "grid.json"
    slope_tif = interim / "terrain" / "slope_5m.tif"
    offsets_json = interim / "engine" / "pointer_offsets.json"
    inputs: list[dict[str, Any]] = [
        {"path": str(Path("terrain/grid.json")), "owner": "WS1", "present": grid_json.exists()},
        {"path": str(Path("terrain/slope_5m.tif")), "owner": "WS1", "present": slope_tif.exists()},
        {"path": str(NAV_INDEX), "owner": "WS9", "present": (interim / NAV_INDEX).exists()},
        {"path": str(Path("engine/public/pad.json")), "owner": "WS2",
         "present": (interim / "engine" / "public" / "pad.json").exists()},
    ]
    if with_pointer:
        inputs.append({"path": str(Path("engine/pointer_offsets.json")), "owner": "WS2",
                       "present": offsets_json.exists()})
    for sc in ids:
        for name in ("t_home", "o2_home") + (("pointer",) if with_pointer else ()):
            p = interim / "engine" / sc / f"{name}.tif"
            inputs.append({"path": str(Path(f"engine/{sc}/{name}.tif")), "owner": "WS2",
                           "present": p.exists()})
    rep: dict[str, Any] = {"written": [], "skipped": {}, "inputs": inputs, "sizes": {}}
    if dry_run:
        for r in inputs:
            log(f"{'ok     ' if r['present'] else 'MISSING'} {r['owner']} {r['path']}")
        return rep
    if not grid_json.exists():
        raise FileNotFoundError(f"{grid_json} missing (WS1): no field grid, nothing written")

    grid = json.loads(grid_json.read_text())
    g5 = grid["grids"]["fields_5m"]
    res = float(g5["res_m"])
    if not math.isclose(res, float(hud["field_png"]["res_m"])):
        raise ValueError(f"grid.json fields_5m res {res} != hud.yaml field_png.res_m")
    shape = (int(g5["height"]), int(g5["width"]))
    nw5 = (float(g5["nw_xy"][0]), float(g5["nw_xy"][1]))
    pad = pad_in_use(interim, grid)
    pad_xy = pad["xy"]
    rep["pad"] = pad
    log(f"home_bearing pad: {pad['source']} ({pad['lon']}, {pad['lat']})")

    idx_path = out_root / "fields" / "index.json"
    entries: dict[str, dict[str, Any]] = {}
    if scenarios and idx_path.exists():  # partial run: keep the other scenarios' entries
        entries = {k: v for k, v in json.loads(idx_path.read_text())["fields"].items()
                   if (v["scenario"] not in ids)}
    kw = {"manifest_fragment_dir": manifest_fragment_dir}

    def put(key: str, values: np.ndarray, scenario: str | None, **extra_kw: Any) -> None:
        entries[key] = write_field(out_root, key, values, scenario, hud, **kw, **extra_kw)
        rep["written"].append(key)
        log(f"wrote fields/{extra_kw.get('file_key') or key}.png")

    if slope_tif.exists():
        s, s_nw, s_res = _read_tif(slope_tif)
        put("slope", sample_centres(s, s_nw, s_res, nw5, res, shape), None,
            file_key="shared/slope")
    else:
        rep["skipped"]["slope"] = "missing terrain/slope_5m.tif (WS1)"

    for sc in ids:
        t_path = interim / "engine" / sc / "t_home.tif"
        if not t_path.exists():
            rep["skipped"][f"{sc}/t_home"] = f"missing engine/{sc}/t_home.tif (WS2)"
            continue
        t, t_nw, t_res = _read_tif(t_path)
        put(f"{sc}/t_home", sample_centres(t, t_nw, t_res, nw5, res, shape), sc)
        o2_path = interim / "engine" / sc / "o2_home.tif"
        o2 = None
        if o2_path.exists():
            o2, o_nw, o_res = _read_tif(o2_path)
            if (o_nw, o_res, o2.shape) != (t_nw, t_res, t.shape):
                raise ValueError(f"{sc}: o2_home grid differs from t_home")
            put(f"{sc}/o2_home", sample_centres(o2, t_nw, t_res, nw5, res, shape), sc)
        else:
            rep["skipped"][f"{sc}/o2_home"] = f"missing engine/{sc}/o2_home.tif (WS2)"
        if sc == worst_sc:
            put(f"{sc}/home_bearing", home_bearing_deg(nw5, res, shape, pad_xy), sc)
            from pipeline.provenance.manifest import record

            for ax in ("lon", "lat"):
                record(f"fields.{sc}/home_bearing.pad_{ax}", pad[ax], "deg",
                       f"fields/{sc}/home_bearing.png", SCRIPT,
                       fragment_dir=manifest_fragment_dir)
            for base, arr in (("t_home", t), ("o2_home", o2)):
                if arr is None:
                    continue
                wf = worstcase.worst_case_fields(arr, t_res, radii, unknown="ignore")
                for r_m, (r_eff, wc) in wf.items():
                    put(f"{sc}/{base}_worst_{r_m}",
                        sample_centres(wc, t_nw, t_res, nw5, res, shape), sc,
                        extra={"radius_m_effective": r_eff})
        if with_pointer:
            p_path = interim / "engine" / sc / "pointer.tif"
            if p_path.exists() and offsets_json.exists():
                _write_pointer(out_root, sc, p_path, offsets_json, hud, entries, rep, log, kw)
            else:
                miss = (f"engine/{sc}/pointer.tif" if not p_path.exists()
                        else "engine/pointer_offsets.json")
                rep["skipped"][f"{sc}/pointer"] = f"missing {miss} (WS2)"

    bounds = _lonlat_bounds(g5)
    nav_path = interim / NAV_INDEX
    if nav_path.exists():
        added, why = merge_nav_index(
            entries, {"bounds": bounds, "width": shape[1], "height": shape[0], "res_m": res},
            json.loads(nav_path.read_text()), nav_path.parent)
        if why:
            rep["skipped"]["fix_interval"] = why
        else:
            rep["merged_nav"] = added
            log(f"merged WS9 entries: {', '.join(added) or 'none'}")
    else:
        rep["skipped"]["fix_interval"] = f"missing {NAV_INDEX} (WS9)"
    idx = build_index(bounds, shape[1], shape[0], res, entries, dummy=False)
    idx_path.parent.mkdir(parents=True, exist_ok=True)
    idx_path.write_text(json.dumps(idx, indent=1) + "\n")
    for k, e in idx["fields"].items():
        f = out_root / e["file"]
        if f.exists():
            rep["sizes"][k] = f.stat().st_size
    total = sum(rep["sizes"].values())
    rep["total_bytes"] = total
    for k, why in rep["skipped"].items():
        log(f"skip {k}: {why}")
    log(f"fields: {len(idx['fields'])} PNGs, {total / 1e6:.1f} MB -> {out_root / 'fields'}")
    return rep


def _write_pointer(out_root, sc, p_path, offsets_json, hud, entries, rep, log, kw) -> None:
    """WS2's pointer on its native 3 m grid (contracts v1.1.1: own grid keys + ``stencil``)."""
    import rasterio

    offs = json.loads(offsets_json.read_text())["offsets_drow_dcol"]
    stencil = [[int(a), int(b)] for a, b in offs]
    with rasterio.open(p_path) as ds:
        ptr = ds.read(1)
        t = ds.transform
        h, w = ptr.shape
    grid = json.loads((Path(p_path).parents[2] / "terrain" / "grid.json").read_text())
    g3 = grid["grids"]["route_3m"]
    if ((int(g3["width"]), int(g3["height"])) != (w, h) or not math.isclose(t.a, g3["res_m"])
            or not math.isclose(-t.e, g3["res_m"])
            or any(abs(a - b) > 1e-3 for a, b in zip((t.c, t.f), g3["nw_xy"], strict=True))):
        raise ValueError(f"{p_path}: not on grid.json route_3m")
    key = f"{sc}/pointer"
    entries[key] = write_field(out_root, key, pointer_values(ptr, len(stencil)), sc, hud,
                               extra={"bounds": [round(float(x), 6) for x in g3["bounds_lonlat"]],
                                      "width": w, "height": h, "res_m": g3["res_m"],
                                      "stencil": stencil}, **kw)
    rep["written"].append(key)
    log(f"wrote fields/{key}.png (own {w} x {h} grid at {g3['res_m']:g} m)")


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scenarios", nargs="*", help="scenario ids (default: variants.yaml ids)")
    ap.add_argument("--interim", default=str(INTERIM))
    ap.add_argument("--out", default=None, help="output root (default data/interim/export)")
    ap.add_argument("--dry-run", action="store_true", help="list inputs, write nothing")
    ap.add_argument("--no-pointer", dest="with_pointer", action="store_false",
                    help="skip {scenario}/pointer (the way-home pointer, written by default)")
    ap.add_argument("--with-pointer", dest="with_pointer", action="store_true",
                    help=argparse.SUPPRESS)  # pre-v1.1.1 spelling; now the default
    ap.set_defaults(with_pointer=True)
    return ap


def main(argv: list[str] | None = None) -> int:
    a = build_arg_parser().parse_args(argv)
    rep = run(interim=a.interim, out_root=a.out, scenarios=a.scenarios, dry_run=a.dry_run,
              with_pointer=a.with_pointer)
    if not a.dry_run and not rep["written"]:
        print("no field written", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

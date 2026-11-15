"""Parity comparator (D56, WS11 plan row 1.4): is a server-built result tree equal to the batch
tree?

Rules (docs/backend.md F35 "Parity test"):
- field grids exact: rasters (.tif) and arrays (.npy) have the same shape, dtype, georeference
  and every cell equal (NaN == NaN); every other non-JSON file (PNG ...) is byte-identical;
- JSON and GeoJSON: the same structure, keys, strings, booleans and nulls; numbers equal to 6
  decimals (``numbers_equal``);
- manifest: the same keys, and every entry field equal (numbers to 6 decimals) except the fields
  in ``IGNORED``.

``IGNORED`` is the single allow-list of values parity does not compare. Nothing else is skipped.
Every difference is collected (``Diff``) and ``report`` lists every differing file, not just
the first one.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

DECIMALS = 6
HALF_UNIT = 0.5 * 10.0**-DECIMALS  # two values within half a unit of the 6th decimal are equal
DETAILS_PER_FILE = 5  # report lines per differing file (the file itself is always listed)

# The ONLY values parity ignores, as {file: (JSON path pattern, ...)}. A pattern is a tuple of
# keys ("*" = any one key or index) and covers the whole subtree under it.
IGNORED: dict[str, tuple[tuple[str, ...], ...]] = {
    # Provenance stamps of a manifest entry: when (utc) and from which commit a value was
    # recorded. They say when a value was made, not what it is (WS6 manifest contract).
    "manifest.json": (("*", "utc"), ("*", "commit")),
    # K9 determinism report (PR #4, STATUS.md WS2 2026-11-14T19:44Z): two runs on the same
    # inputs are byte-identical except the wall-clock timings in the internal summary.json
    # (`timing_s`, `d21.screening.screening_s`). Since D51 no published file carries a timing.
    "summary.json": (("timing_s",), ("d21", "screening", "screening_s")),
}

RASTER_SUFFIXES = (".tif", ".tiff")
JSON_SUFFIXES = (".json", ".geojson")


@dataclass(frozen=True)
class Diff:
    """One difference: ``file`` (tree-relative), ``where`` (JSON path or aspect), ``detail``."""

    file: str
    where: str
    detail: str

    def __str__(self) -> str:
        return f"{self.file} {self.where}: {self.detail}" if self.where else \
            f"{self.file}: {self.detail}"  # fmt: skip


@dataclass
class Result:
    """Outcome of a comparison: the differences and what was compared."""

    diffs: list[Diff] = field(default_factory=list)
    compared: list[str] = field(default_factory=list)
    identical_bytes: list[str] = field(default_factory=list)

    def extend(self, other: Result) -> None:
        self.diffs += other.diffs
        self.compared += other.compared
        self.identical_bytes += other.identical_bytes

    @property
    def differing_files(self) -> list[str]:
        return sorted({d.file for d in self.diffs})

    @property
    def ok(self) -> bool:
        return not self.diffs


# ------------------------------------------------------------------ values


def numbers_equal(a: float, b: float) -> bool:
    """Equal to 6 decimals: the same after rounding to 6 decimals, or within half a unit of the
    6th decimal (so noise at the 7th decimal never fails across a rounding boundary)."""
    if isinstance(a, int) and isinstance(b, int):
        return a == b
    fa, fb = float(a), float(b)
    if math.isnan(fa) or math.isnan(fb):
        return math.isnan(fa) and math.isnan(fb)
    if math.isinf(fa) or math.isinf(fb):
        return fa == fb
    return round(fa, DECIMALS) == round(fb, DECIMALS) or abs(fa - fb) < HALF_UNIT


def is_ignored(file: str, path: tuple) -> bool:
    for pat in IGNORED.get(file, ()):
        head = path[: len(pat)]  # a pattern covers the whole subtree under it
        same = len(head) == len(pat)
        if same and all(p in ("*", str(k)) for p, k in zip(pat, head, strict=True)):
            return True
    return False


def _fmt(path: tuple) -> str:
    return "/" + "/".join(str(k) for k in path)


def _short(v) -> str:
    s = json.dumps(v, sort_keys=True, default=str)
    return s if len(s) <= 80 else s[:77] + "..."


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def compare_json(server, batch, *, file: str, path: tuple = ()) -> list[Diff]:
    """Every difference between two parsed JSON values (server vs batch)."""
    if is_ignored(file, path):
        return []
    where = _fmt(path)
    if isinstance(server, dict) and isinstance(batch, dict):
        out: list[Diff] = []
        for k in sorted(set(server) | set(batch), key=str):
            if is_ignored(file, (*path, k)):
                continue
            if k not in batch:
                out.append(Diff(file, _fmt((*path, k)), "only on the server"))
            elif k not in server:
                out.append(Diff(file, _fmt((*path, k)), "missing on the server"))
            else:
                out += compare_json(server[k], batch[k], file=file, path=(*path, k))
        return out
    if isinstance(server, list) and isinstance(batch, list):
        if len(server) != len(batch):
            return [Diff(file, where, f"length server {len(server)} != batch {len(batch)}")]
        out = []
        for i, (a, b) in enumerate(zip(server, batch, strict=True)):
            out += compare_json(a, b, file=file, path=(*path, i))
        return out
    if _is_num(server) and _is_num(batch):
        if numbers_equal(server, batch):
            return []
        return [Diff(file, where, f"server {server!r} != batch {batch!r} (6 decimals)")]
    if type(server) is not type(batch) or server != batch:
        return [Diff(file, where, f"server {_short(server)} != batch {_short(batch)}")]
    return []


# ------------------------------------------------------------------ files


def _raster(path: Path) -> tuple[np.ndarray, dict]:
    import rasterio

    with rasterio.open(path) as ds:
        meta = {"shape": (ds.count, ds.height, ds.width), "dtypes": ds.dtypes,
                "transform": tuple(ds.transform), "crs": ds.crs.to_wkt() if ds.crs else None,
                "nodata": ds.nodata}  # fmt: skip
        return ds.read(), meta


def _arrays_equal(a: np.ndarray, b: np.ndarray) -> bool:
    if a.shape != b.shape or a.dtype != b.dtype:
        return False
    if np.issubdtype(a.dtype, np.floating):
        return bool(np.array_equal(a, b, equal_nan=True))
    return bool(np.array_equal(a, b))


def _array_diff(rel: str, a: np.ndarray, b: np.ndarray) -> list[Diff]:
    if a.shape != b.shape or a.dtype != b.dtype:
        return [Diff(rel, "array", f"server {a.dtype}{a.shape} != batch {b.dtype}{b.shape}")]
    if _arrays_equal(a, b):
        return []
    neq = ~((a == b) | (np.isnan(a) & np.isnan(b))) if np.issubdtype(a.dtype, np.floating) \
        else a != b  # fmt: skip
    idx = tuple(int(i) for i in np.argwhere(neq)[0])
    return [
        Diff(
            rel,
            "array",
            f"{int(neq.sum())} cells differ (exact); first {list(idx)}: "
            f"server {a[idx]!r} != batch {b[idx]!r}",
        )
    ]


def compare_file(server: Path, batch: Path, rel: str) -> Result:
    """Compare one file by kind; ``rel`` names it in the report (and selects IGNORED rules)."""
    res = Result(compared=[rel])
    if not batch.is_file():
        res.diffs.append(Diff(rel, "", "missing in the batch tree"))
        return res
    if not server.is_file():
        res.diffs.append(Diff(rel, "", "missing in the server tree"))
        return res
    sb, bb = server.read_bytes(), batch.read_bytes()
    if sb == bb:
        res.identical_bytes.append(rel)
        return res
    suffix = server.suffix.lower()
    if suffix in JSON_SUFFIXES:
        try:
            sj, bj = json.loads(sb), json.loads(bb)
        except ValueError as e:
            res.diffs.append(Diff(rel, "", f"not JSON: {e}"))
            return res
        res.diffs += compare_json(sj, bj, file=rel)
    elif suffix in RASTER_SUFFIXES:
        (sa, sm), (ba, bm) = _raster(server), _raster(batch)
        for k in sm:
            if sm[k] != bm[k]:
                res.diffs.append(Diff(rel, k, f"server {sm[k]!r} != batch {bm[k]!r}"))
        if sm["shape"] == bm["shape"]:
            res.diffs += _array_diff(rel, sa, ba)
    elif suffix == ".npy":
        res.diffs += _array_diff(rel, np.load(server), np.load(batch))
    else:
        res.diffs.append(Diff(rel, "bytes", f"server {len(sb)} B != batch {len(bb)} B "
                                            "(byte-exact file)"))  # fmt: skip
    return res


def compare_trees(server_root: Path, batch_root: Path, rels: Iterable[str]) -> Result:
    """Compare ``rels`` (tree-relative paths) between two trees."""
    res = Result()
    for rel in sorted(rels):
        res.extend(compare_file(Path(server_root) / rel, Path(batch_root) / rel, rel))
    return res


def compare_manifest(server: dict, batch: dict, *, name: str = "manifest.json") -> Result:
    """Manifest entries {key: {value, units, file, script, utc, commit}}: the same key set and
    every entry field equal except IGNORED (``name`` selects the rules)."""
    return Result(diffs=compare_json(server, batch, file=name), compared=[name])


def read_tree_files(root: Path) -> list[str]:
    """Every file under ``root`` (tree-relative POSIX paths, sorted)."""
    root = Path(root)
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())


# ------------------------------------------------------------------ report


def report(res: Result, *, title: str = "parity") -> str:
    """Every differing file with up to DETAILS_PER_FILE differences each, plus the counts."""
    files = res.differing_files
    lines = [f"{title}: {len(res.compared)} files compared, {len(res.identical_bytes)} "
             f"byte-identical, {len(files)} differ"]  # fmt: skip
    for f in files:
        ds = [d for d in res.diffs if d.file == f]
        lines.append(f"  {f} ({len(ds)} difference{'s' if len(ds) != 1 else ''})")
        lines += [f"    {d.where or '-'}: {d.detail}" for d in ds[:DETAILS_PER_FILE]]
        if len(ds) > DETAILS_PER_FILE:
            lines.append(f"    ... {len(ds) - DETAILS_PER_FILE} more")
    return "\n".join(lines)

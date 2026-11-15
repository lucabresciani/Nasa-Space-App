"""WS11 task 5 (backend plan 2.1): the server data folder ``$HL_SERVER_DATA`` for the live engine.

    uv run --no-sync python tools/make_serverdata.py --out data/server [--force]
    flock /tmp/hl-heavy.lock make serverdata HL_SERVER_DATA=<dir>      # HEAVY: full 3 m grid

Every number comes from ``pipeline/engine`` (WS11 rule 1): station fields through
``padpick.station_fields``, the grid through ``graph.load_ws1_grid``, the ridge mask through
``scenarios.load_ridge``. Nothing here routes, rounds or edits a value.

Output tree (paths relative to ``--out``; each one is listed in the manifest with its sha256):

    manifest.json                       this manifest; its sha256 is the ``terrain_hash`` of
                                        /engine/version and of the D57 result hash
                                        (server/engine/version.py SERVER_DATA_MANIFEST)
    terrain/<file>                      byte copies of the WS1 inputs: elev_3m, maxslope_3m,
                                        cellstate_3m, slope_3m, stepguard_3m, ridge_index (.tif)
                                        and stations.json, so build_plan(terrain_dir=...) and
                                        load_ws1_grid run on this folder unchanged
    grid/<array>.npy                    the grid exactly as load_ws1_grid returns it, one .npy per
                                        array (elev, maxslope, slope: float64; cellstate: uint8;
                                        stepguard: bool) plus ridge_3m.npy (scenarios.load_ridge,
                                        float64); read with np.load(path, mmap_mode="r") (spec 4.1:
                                        grids memory-mapped read-only and shared by the workers)
    fields/<scenario>/<station>.forward.npy   float32 minutes, station access cell -> every cell
    fields/<scenario>/<station>.reverse.npy   float32 minutes, every cell -> station access cell
                                        (inf = unreached); padpick.station_fields for the three
                                        variants at crew.default_suit_kg (spec 4.1: 2 per station
                                        per scenario, float32, pad-independent). Memory-mappable.
    conditions/<name>.json              WS4 conditions (byte copies; pipeline.conditions.margins
                                        .margin_inputs(root=$HL_SERVER_DATA) reads them)
    cards/<S>.json                      WS3 horizon card parts: the half of a station card the
                                        engine does not compute (tools/make_web.py merges it with
                                        the engine's cards/<S>.timeline.json part)

Manifest shape (no contract exists for it; ``validate_manifest`` checks this shape):

    {
      "format": "homeline-serverdata", "format_version": 1,
      "built_from": {                   # what the data were built from (no clock, no host path)
        "tool": "tools/make_serverdata.py",
        "engine_tree": <git rev-parse HEAD:pipeline>, "engine_tree_dirty": <bool>,
        "config_hash": <tools.make_bundle.config_hash()>,
        "inputs": {<output-relative path of the source>: <sha256 hex>, ...}
      },
      "suit_kg": 104, "scenarios": ["opt_104", "nom_104", "con_104"],
      "fields": {"dtype": "float32", "units": "min", "unreached": "inf"},
      "grid": {"shape": [h, w], "res_m", "x0", "y0", "crs",
               "arrays": {<name>: {"path", "dtype"}}},
      "stations": {<id>: {"lon", "lat",
                          "fields": {<scenario>: {"access_rc": [r, c], "forward", "reverse"}},
                          "no_access": {<scenario>: <reason>}}},
      "stations_without_position": [<id>, ...],
      "files": {<path>: {"sha256": <hex>, "bytes": <int>}}     # every file but manifest.json
    }

Deterministic and idempotent: no timestamps or absolute paths, sorted keys, byte copies and
np.save (no clock in the header). A run whose ``built_from`` equals the existing manifest's and
whose files all verify is a no-op ("up to date"); ``--force`` rebuilds and writes the same bytes.
Atomic: everything is built in a hidden sibling ``.<out>.tmp-<pid>`` and swapped in by rename.
Entries of ``--out`` this tool does not own (e.g. the ``results/`` cache, backend.yaml cache.dir)
are moved into the new tree before the swap.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:  # `python tools/make_serverdata.py` (Makefile) puts tools/ first
    sys.path.insert(0, str(REPO))

from pipeline.engine import padpick, physio, scenarios  # noqa: E402
from pipeline.engine.config import INTERIM_DIR, load  # noqa: E402
from pipeline.engine.graph import D22_FILES, load_ws1_grid  # noqa: E402
from pipeline.engine.stations import load_ws1_stations  # noqa: E402
from tools.make_bundle import config_hash  # noqa: E402
from tools.make_web import CARD_PARTS  # noqa: E402

TOOL = "tools/make_serverdata.py"
FORMAT = "homeline-serverdata"
FORMAT_VERSION = 1
MANIFEST = "manifest.json"  # = server/engine/version.py SERVER_DATA_MANIFEST (E1)
OWNED = (MANIFEST, "terrain", "grid", "fields", "conditions", "cards")
# graph.load_ws1_grid's inputs (the D22 pair from graph.D22_FILES), then the extra build_plan
# reads (stations.json; ridge_index.tif for the partner line).
GRID_TIFS = ("elev_3m.tif", "maxslope_3m.tif", "cellstate_3m.tif", *D22_FILES)
TERRAIN_FILES = (*GRID_TIFS, "ridge_index.tif", "stations.json")
GRID_ARRAYS = ("elev", "maxslope", "slope", "cellstate", "stepguard")
CHUNK = 1 << 22


class ServerDataError(RuntimeError):
    """An input is missing or the engine identity cannot be read (reported, never invented)."""


# ------------------------------------------------------------------------------ helpers ----
def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while b := fh.read(CHUNK):
            h.update(b)
    return h.hexdigest()


def dump_json(obj) -> bytes:
    return (json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def _git(*args: str) -> str:
    try:
        r = subprocess.run(["git", *args], cwd=REPO, check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as e:
        raise ServerDataError(f"git {' '.join(args)} failed: {e}") from e
    return r.stdout.strip()


def engine_identity() -> dict:
    """engine_tree as server/engine/version.py takes it (D57); dirty = uncommitted changes under
    pipeline/ or config/, i.e. the tree id does not describe the code that ran."""
    return {"engine_tree": _git("rev-parse", "HEAD:pipeline"),
            "engine_tree_dirty": bool(_git("status", "--porcelain", "--", "pipeline", "config")),
            "config_hash": config_hash()}  # fmt: skip


def variant_scenarios() -> tuple[int, list[str]]:
    """(suit kg, scenario ids): every configured scenario at crew.default_suit_kg, one per
    variant (spec 4.1: precomputed for 3 variants at 104 kg)."""
    suit = int(load("crew")["default_suit_kg"])
    sids = [s for s in load("variants")["scenarios"]["ids"] if physio.parse_scenario(s)[1] == suit]
    variants = {physio.parse_scenario(s)[0] for s in sids}
    if len(variants) != len(sids) or variants != set(load("variants")["variants"]):
        raise ServerDataError(f"variants.yaml scenarios.ids at {suit} kg: {sids} is not one per "
                              "variant")  # fmt: skip
    return suit, sids


def sources(terrain: Path, conditions: Path, cards: Path) -> dict[str, Path]:
    """{output path: source path}, sorted. Every listed input must exist."""
    src: dict[str, Path] = {}
    missing = [str(terrain / f) for f in TERRAIN_FILES if not (terrain / f).is_file()]
    src.update({f"terrain/{f}": terrain / f for f in TERRAIN_FILES})
    cond = sorted(conditions.glob("*.json")) if conditions.is_dir() else []
    if not cond:
        missing.append(f"{conditions}/*.json (WS4 conditions)")
    src.update({f"conditions/{p.name}": p for p in cond})
    card = sorted(p for p in cards.glob("*.json") if CARD_PARTS["WS3"].match(p.name)) \
        if cards.is_dir() else []  # fmt: skip
    if not card:
        missing.append(f"{cards}/S*.json (WS3 horizon card parts)")
    src.update({f"cards/{p.name}": p for p in card})
    if missing:
        raise ServerDataError("server data inputs missing: " + ", ".join(missing))
    return dict(sorted(src.items()))


def built_from(src: dict[str, Path]) -> dict:
    return {"tool": TOOL, **engine_identity(),
            "inputs": {k: sha256_file(p) for k, p in src.items()}}  # fmt: skip


# ------------------------------------------------------------------------------ manifest ----
def validate_manifest(m: dict) -> None:
    """Check the shape in the module docstring; raise ValueError on the first difference."""

    def need(cond, what):
        if not cond:
            raise ValueError(f"server data manifest: {what}")

    need(m.get("format") == FORMAT and m.get("format_version") == FORMAT_VERSION, "format")
    keys = {"format", "format_version", "built_from", "suit_kg", "scenarios", "fields", "grid",
            "stations", "stations_without_position", "files"}  # fmt: skip
    need(set(m) == keys, f"keys {sorted(set(m) ^ keys)}")
    bf = m["built_from"]
    need(set(bf) == {"tool", "engine_tree", "engine_tree_dirty", "config_hash", "inputs"},
         "built_from keys")
    need(isinstance(bf["engine_tree"], str) and len(bf["engine_tree"]) == 40, "engine_tree")
    need(isinstance(bf["config_hash"], str) and bf["config_hash"].startswith("sha256:"),
         "config_hash")
    need(all(_is_hex(v) for v in bf["inputs"].values()), "built_from.inputs sha256")
    files = m["files"]
    need(MANIFEST not in files, "the manifest lists itself")
    for path, e in files.items():
        need(set(e) == {"sha256", "bytes"} and _is_hex(e["sha256"])
             and isinstance(e["bytes"], int) and e["bytes"] >= 0, f"files[{path}]")  # fmt: skip
        need(path.split("/")[0] in OWNED and ".." not in path.split("/"), f"path {path}")
    need(set(bf["inputs"]) <= set(files), "an input without its copy")
    g = m["grid"]
    need(len(g["shape"]) == 2 and all(isinstance(v, int) for v in g["shape"]), "grid.shape")
    need(set(g["arrays"]) == {*GRID_ARRAYS, "ridge_3m"}, "grid.arrays")
    need(all(a["path"] in files for a in g["arrays"].values()), "grid array not in files")
    need(m["fields"] == {"dtype": "float32", "units": "min", "unreached": "inf"}, "fields")
    for sid, st in m["stations"].items():
        done, none = set(st["fields"]), set(st["no_access"])
        need(not done & none and done | none == set(m["scenarios"]), f"stations[{sid}] scenarios")
        for f in st["fields"].values():
            need(f["forward"] in files and f["reverse"] in files, f"stations[{sid}] field files")
            need(len(f["access_rc"]) == 2, f"stations[{sid}] access_rc")


def _is_hex(s) -> bool:
    return isinstance(s, str) and len(s) == 64 and all(c in "0123456789abcdef" for c in s)


def verify(out: Path, m: dict) -> list[str]:
    """Files of manifest ``m`` under ``out`` that are missing or differ (empty = all verify)."""
    bad = []
    for rel, e in m["files"].items():
        p = out / rel
        if not p.is_file() or p.stat().st_size != e["bytes"] or sha256_file(p) != e["sha256"]:
            bad.append(rel)
    return bad


# --------------------------------------------------------------------------------- build ----
def _save(root: Path, rel: str, arr: np.ndarray) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as fh:
        np.save(fh, np.ascontiguousarray(arr), allow_pickle=False)


def build_tree(tmp: Path, src: dict[str, Path], bf: dict, suit: int, sids: list[str],
               say=print) -> dict:  # fmt: skip
    """Write the whole tree into ``tmp``; returns the manifest (also written there)."""
    for rel, p in src.items():
        (tmp / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, tmp / rel)
    terr = tmp / "terrain"
    t0 = time.perf_counter()
    grid = load_ws1_grid(terr)
    arrays = {name: getattr(grid, name) for name in GRID_ARRAYS}
    arrays["ridge_3m"] = scenarios.load_ridge(terr, grid)
    grid_meta = {"shape": [int(v) for v in grid.shape], "res_m": float(grid.res_m),
                 "x0": float(grid.x0), "y0": float(grid.y0), "crs": grid.crs, "arrays": {}}
    for name, a in arrays.items():
        rel = f"grid/{name}.npy"
        _save(tmp, rel, a)
        grid_meta["arrays"][name] = {"path": rel, "dtype": str(np.asarray(a).dtype)}
    say(f"grid {grid.shape} at {grid.res_m} m: {time.perf_counter() - t0:.1f} s")

    st_list, no_pos = load_ws1_stations(terr / "stations.json")
    settings = padpick.settings_from_config()
    stations: dict[str, dict] = {}
    for st in st_list:
        rec = {"lon": st["lon"], "lat": st["lat"], "fields": {}, "no_access": {}}
        for sid in sids:
            t0 = time.perf_counter()
            try:
                fwd, rev = padpick.station_fields(grid, st, sid, settings)
            except physio.MissingInput as e:
                rec["no_access"][sid] = str(e)
                say(f"{st['id']} {sid}: no access cell ({e})")
                continue
            f = {"access_rc": [int(v) for v in fwd.seeds[0]]}
            for kind, fld in (("forward", fwd), ("reverse", rev)):
                f[kind] = f"fields/{sid}/{st['id']}.{kind}.npy"
                _save(tmp, f[kind], fld.t_min.astype(np.float32))
            rec["fields"][sid] = f
            del fwd, rev
            say(f"{st['id']} {sid}: access cell {f['access_rc']}, "
                f"{time.perf_counter() - t0:.1f} s", flush=True)
        stations[st["id"]] = rec

    files = {}
    for p in sorted(tmp.rglob("*")):
        if p.is_file():
            files[p.relative_to(tmp).as_posix()] = {"sha256": sha256_file(p),
                                                    "bytes": p.stat().st_size}
    m = {"format": FORMAT, "format_version": FORMAT_VERSION, "built_from": bf, "suit_kg": suit,
         "scenarios": sids, "fields": {"dtype": "float32", "units": "min", "unreached": "inf"},
         "grid": grid_meta, "stations": stations, "stations_without_position": sorted(no_pos),
         "files": dict(sorted(files.items()))}  # fmt: skip
    validate_manifest(m)
    (tmp / MANIFEST).write_bytes(dump_json(m))
    return m


def swap_in(tmp: Path, out: Path) -> None:
    """Replace ``out`` by ``tmp``; entries of ``out`` this tool does not own move along."""
    if not out.exists():
        os.rename(tmp, out)
        return
    for p in sorted(out.iterdir()):
        if p.name not in OWNED and not (tmp / p.name).exists():
            os.rename(p, tmp / p.name)
    old = out.parent / f".{out.name}.old-{os.getpid()}"
    os.rename(out, old)
    os.rename(tmp, out)
    shutil.rmtree(old)


def make_serverdata(out: Path, terrain: Path, conditions: Path, cards: Path, *,
                    force: bool = False, say=print) -> tuple[dict, bool]:  # fmt: skip
    """Build (or confirm) the server data in ``out``; returns (manifest, rebuilt)."""
    out = Path(out).absolute()
    suit, sids = variant_scenarios()
    src = sources(Path(terrain), Path(conditions), Path(cards))
    bf = built_from(src)
    if bf["engine_tree_dirty"]:
        say("warning: uncommitted changes under pipeline/ or config/ (engine_tree_dirty: true)")
    mf = out / MANIFEST
    if not force and mf.is_file():
        old = json.loads(mf.read_text(encoding="utf-8"))
        same = (old.get("format_version") == FORMAT_VERSION and old.get("built_from") == bf
                and old.get("scenarios") == sids and not verify(out, old))  # fmt: skip
        if same:
            say(f"{out}: up to date ({len(old['files'])} files verified)")
            return old, False
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.parent / f".{out.name}.tmp-{os.getpid()}"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir()
    try:
        m = build_tree(tmp, src, bf, suit, sids, say)
        swap_in(tmp, out)
    finally:
        if tmp.exists():
            shutil.rmtree(tmp)
    return m, True


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, required=True, help="$HL_SERVER_DATA")
    ap.add_argument("--terrain", type=Path, default=INTERIM_DIR / "terrain")
    ap.add_argument("--conditions", type=Path, default=INTERIM_DIR / "conditions")
    ap.add_argument("--cards", type=Path, default=INTERIM_DIR / "horizon" / "public" / "cards")
    ap.add_argument("--force", action="store_true", help="rebuild even when up to date")
    a = ap.parse_args(argv)
    t0 = time.perf_counter()
    try:
        m, rebuilt = make_serverdata(a.out, a.terrain, a.conditions, a.cards, force=a.force)
    except ServerDataError as e:
        print(f"make_serverdata: {e}", file=sys.stderr)
        return 2
    size = sum(e["bytes"] for e in m["files"].values())
    peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024  # Linux: KiB
    print(f"{'wrote' if rebuilt else 'kept'} {a.out}: {len(m['files'])} files + {MANIFEST}, "
          f"{size / 1e6:.1f} MB; manifest sha256 "
          f"{sha256_file(Path(a.out) / MANIFEST)}; wall {time.perf_counter() - t0:.1f} s; "
          f"peak RSS {peak_mb:.0f} MB")  # fmt: skip
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

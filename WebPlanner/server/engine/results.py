"""Result trees by hash (F23, F35; WS11 plan row 1.3): GET /results/{hash}/{path}.

A result tree has the same file names and schemas as ``web/public/data/`` plus ``run_record.json``
(backend kit rule 2, contracts/backend/README.md "Result tree"). Resolution of a hash:

1. the official pad's hash (``hashing.official_hash`` with the live identity) -> the PRECOMPUTED
   tree ``web/public/data/``, read-only. It has no ``run_record.json`` on disk, so one is
   synthesised (origin ``precomputed``, run_record.schema.json description: "written by WS11 ...
   for the pinned precomputed ones") and validated before it is served; nothing is ever written
   into ``web/public/data/``;
2. any other hash -> ``$HL_SERVER_DATA/{cache.dir}/{hash}/`` (config/backend.yaml ``cache.dir``),
   written by the job runner (plan row 2.4);
3. otherwise ``ResultNotFound``. When the live identity is unavailable (no server data manifest,
   or no git) and the hash is not in the cache, the official hash cannot be computed, so
   ``version.Unavailable`` is raised (the route answers 503, as /engine/version does) instead of a
   404 that could be wrong for the official hash.

Path safety (``resolve_file``): relative "/"-separated paths only; no empty, ".", ".." or hidden
(leading ".") segment, no backslash or NUL; the resolved file (symlinks followed) must lie inside
the resolved tree root and be a regular file. Hidden names are never served, so a writer may use
them for temporary files.

The official tree's ``mission.json`` (D110, WP9c) is the one file served from outside
``web/public/data/``: ``web/public/sim/official/mission.json`` (tools/make_mission.py --official),
so a simulator export of the official plan needs no live job and the data tree stays unchanged.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache, lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from server.engine import version
from server.engine.hashing import (
    EngineIdentity,
    canonical_inputs,
    engine_identity,
    official_hash,
    official_inputs,
)
from server.settings import settings
from tools.validate_contracts import match_schema

REPO = Path(__file__).resolve().parents[2]
PRECOMPUTED_DIR = REPO / "web" / "public" / "data"
BACKEND_CONTRACTS = REPO / "contracts" / "backend"
RUN_RECORD = "run_record.json"  # contracts/backend/README.md "Result tree"
MISSION = "mission.json"  # contracts/bundle mission.schema.json, at the root of a result tree
OFFICIAL_MISSION = REPO / "web" / "public" / "sim" / "official" / MISSION  # D110, outside DATA
MAX_PATH_CHARS = 1024
JSON_SUFFIXES = {".json", ".geojson"}

# Media types of the file kinds in a result tree (web/public/data). .gz files (fp3d) are served as
# gzip bytes WITHOUT Content-Encoding: the fp3d loader gunzips them itself (web/src/fp3d/format.ts).
MEDIA_TYPES = {
    ".json": "application/json",
    ".geojson": "application/geo+json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".gz": "application/gzip",
}
DEFAULT_MEDIA_TYPE = "application/octet-stream"


class ResultNotFound(LookupError):
    """No result tree for the hash, or no servable file at the path (route: 404)."""

    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}")


@dataclass(frozen=True)
class ResultTree:
    hash: str
    root: Path
    precomputed: bool  # True: web/public/data (official pad); run_record.json is synthesised
    identity: EngineIdentity | None  # the identity the official hash was taken with (precomputed)


IdentityProvider = Callable[[], EngineIdentity]


def cache_dir() -> Path:
    """``$HL_SERVER_DATA/{cache.dir}``: one folder per computed result hash."""
    return version.server_data_dir() / settings().cache.dir


def is_result_hash(h: str) -> bool:
    n = settings().compute.hash.hex_chars
    return bool(re.fullmatch(f"[0-9a-f]{{{n}}}", h))


@lru_cache(maxsize=8)
def _official_hash(identity: EngineIdentity) -> str:
    return official_hash(identity)


def resolve_tree(h: str, identity: IdentityProvider = engine_identity) -> ResultTree:
    """The result tree for hash ``h`` (see the module docstring for the order)."""
    if not is_result_hash(h):
        raise ResultNotFound("unknown_result", f"{h!r} is not a result hash")
    try:
        ident = EngineIdentity(*identity())
        unavailable = None
    except version.Unavailable as e:
        ident, unavailable = None, e
    if ident is not None and h == _official_hash(ident):
        return ResultTree(h, PRECOMPUTED_DIR, True, ident)
    d = cache_dir() / h
    if d.is_dir():
        return ResultTree(h, d, False, None)
    if unavailable is not None:
        raise unavailable
    raise ResultNotFound("unknown_result", f"no result tree for hash {h}")


def safe_parts(path: str) -> list[str]:
    """The segments of a relative result path; ResultNotFound("invalid_path") otherwise."""
    bad = (not path or len(path) > MAX_PATH_CHARS or path.startswith("/")
           or "\\" in path or "\0" in path)
    parts = [] if bad else path.split("/")
    if bad or any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        raise ResultNotFound("invalid_path", f"{path!r} is not a file path inside a result tree")
    return parts


def resolve_file(tree: ResultTree, path: str) -> Path:
    """The regular file at ``path`` inside ``tree`` (symlinks followed, but never out of it)."""
    parts = safe_parts(path)
    missing = ResultNotFound("file_not_found", f"no file {path!r} in result {tree.hash}")
    if tree.precomputed and path == MISSION:  # D110: the official plan's mission.json
        root, parts = OFFICIAL_MISSION.parent, [MISSION]
    else:
        root = tree.root
    try:
        root = root.resolve(strict=True)
        real = root.joinpath(*parts).resolve(strict=True)
        mode = real.stat().st_mode
    except (OSError, RuntimeError):  # missing, a symlink loop, a name too long
        raise missing from None
    if not real.is_relative_to(root) or not stat.S_ISREG(mode):
        raise missing
    return real


def media_type(path: str) -> str:
    return MEDIA_TYPES.get(Path(path).suffix.lower(), DEFAULT_MEDIA_TYPE)


@lru_cache(maxsize=8192)
def _sha256_of(path: str, size: int, mtime_ns: int) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def file_sha256(path: Path) -> str:
    """sha256 of a file, cached by (path, size, mtime) so repeated requests hash it once."""
    st = path.stat()
    return _sha256_of(str(path), st.st_size, st.st_mtime_ns)


def etag(sha256_hex: str) -> str:
    """Strong ETag from the content hash (stable across checkouts, unlike mtime)."""
    return f'"{sha256_hex[:32]}"'


# ------------------------------------------------------------- precomputed run record ----
@cache
def _run_record_validator() -> Draft202012Validator:
    docs = [json.loads(p.read_text(encoding="utf-8"))
            for p in BACKEND_CONTRACTS.glob("*.schema.json")]
    registry = Registry().with_resources((d["$id"], Resource.from_contents(d)) for d in docs)
    schema = next(d for d in docs if d["$id"].endswith("/run_record.schema.json"))
    return Draft202012Validator(schema, registry=registry)


def validate_run_record(doc: dict) -> None:
    errors = sorted(_run_record_validator().iter_errors(doc), key=lambda e: e.json_path)
    if errors:
        raise ValueError("run_record does not match run_record.schema.json: "
                         + "; ".join(f"{e.json_path}: {e.message}" for e in errors[:5]))


def tree_files(root: Path) -> list[dict]:
    """run_record ``files``: every servable regular file except run_record.json, sorted by path,
    with the web contract it validates against (tools/validate_contracts.py SCHEMA_MAP)."""
    out = []
    real_root = root.resolve(strict=True)
    for dirpath, dirnames, filenames in os.walk(real_root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            p = Path(dirpath) / name
            rel = p.relative_to(real_root).as_posix()
            if name.startswith(".") or rel == RUN_RECORD:
                continue
            try:  # the files resolve_file would serve: regular, inside the tree
                p = resolve_file(ResultTree("", real_root, False, None), rel)
            except ResultNotFound:
                continue
            contract = match_schema(rel) if p.suffix in JSON_SUFFIXES else None
            out.append({"path": rel, "sha256": file_sha256(p), "bytes": p.stat().st_size,
                        "contract": contract})
    return sorted(out, key=lambda f: f["path"])


def _tree_times(root: Path) -> tuple[str, str]:
    """Earliest and latest ``utc`` of the tree's provenance manifest (when it was built)."""
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    times = sorted(v["utc"] for v in manifest.values() if isinstance(v, dict) and v.get("utc"))
    if not times:
        raise ValueError(f"{root / 'manifest.json'} carries no utc times")
    return times[0], times[-1]


@lru_cache(maxsize=4)
def _precomputed_run_record(h: str, identity: EngineIdentity, root: Path) -> bytes:
    cfg = settings()
    code = version.code_identity()
    started, finished = _tree_times(root)
    doc = {
        "contract_version": cfg.contract_version,
        "hash": h,
        "origin": "precomputed",
        # labels.live is for computed_live results; the official precomputed tree has its own
        # label (team lead, Sat 22:40).
        "label": cfg.labels.precomputed,
        "inputs": canonical_inputs(official_inputs(cfg), cfg),  # what was hashed (D57)
        "engine": {
            "tree": identity.engine_tree,
            "commit": code["commit"],
            "config_hash": identity.config_hash,
            "web_contract_version": code["web_contract_version"],
            "backend_contract_version": code["backend_contract_version"],
        },
        "terrain_hash": identity.terrain_hash,
        "status": "done",
        "started_utc": started,
        "finished_utc": finished,
        "stages": [],
        "files": tree_files(root),
        "range_flags": [],
        "route_mode": "auto",  # D97: the official plan is the engine's own route (F9)
        "infeasible": None,
        "error": None,
        "dummy": False,
    }
    validate_run_record(doc)
    return (json.dumps(doc, indent=1, ensure_ascii=False) + "\n").encode("utf-8")


def precomputed_run_record(tree: ResultTree) -> bytes:
    """The synthesised, validated run_record.json of the precomputed (official) tree."""
    if not tree.precomputed or tree.identity is None:
        raise ValueError("only the precomputed tree has a synthesised run record")
    return _precomputed_run_record(tree.hash, tree.identity, tree.root)

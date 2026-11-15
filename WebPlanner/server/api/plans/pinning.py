"""Pinned result hashes and LRU eviction of the result cache (WS12 plan row 2.5, brief task 5;
spec §4.1 "Cache: on disk, LRU, 20 GB cap; static-shipped hashes never evicted"; F23, F28).

- **Pinned.** ``config/backend.yaml cache.pinned`` names the static-shipped plans: ``official``
  (the official pad with default inputs: GET /defaults ``inputs``) and ``picker`` (the same inputs
  on each picker pad of web/public/data/scenarios/pads/index.json, the pad id kept as when picked).
  Each name resolves to result hashes under the engine identity (D57); an unknown name is refused.
  The official hash is served from web/public/data and never lives in the cache, but it is pinned
  all the same.
- **Eviction.** When the cache (``$HL_SERVER_DATA/{cache.dir}``) is over ``cache.max_gb``, the
  least recently used finished trees go first until it is under the cap. Never removed: a pinned
  hash, a tree without a run record (a job may still be writing it), a hidden entry (the
  runner's ``.job-*`` temp dirs). Last use is the newer of the access and modification time of the
  tree's run_record.json. A tree is first renamed to a hidden name (never served, E3), then deleted.
- **When.** After every accepted new job (the limiter's ``on_new_job`` hook), in a background
  thread; one eviction runs at a time. Without an engine identity the pins cannot be taken, so
  nothing is evicted.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
from collections.abc import Callable
from pathlib import Path

from server.engine import defaults, results, version
from server.engine.hashing import EngineIdentity, official_inputs, result_hash
from server.settings import BackendConfig, settings

log = logging.getLogger(__name__)

EVICT_PREFIX = ".evict-"  # hidden: never served while it is deleted


def _official(ident: EngineIdentity, cfg: BackendConfig) -> list[str]:
    return [result_hash(official_inputs(cfg), ident, cfg)]


def picker_inputs(cfg: BackendConfig | None = None) -> list[dict]:
    """Default inputs on each picker pad (the official pad excluded: it is ``official``)."""
    out = []
    for p in defaults.pads():
        if p.get("picker") and not p.get("official"):
            doc = official_inputs(cfg)
            doc["pad"] = {"id": p["id"], "lon": p["lon"], "lat": p["lat"]}
            out.append(doc)
    return out


def _picker(ident: EngineIdentity, cfg: BackendConfig) -> list[str]:
    return [result_hash(doc, ident, cfg) for doc in picker_inputs(cfg)]


PINNERS: dict[str, Callable[[EngineIdentity, BackendConfig], list[str]]] = {
    "official": _official,
    "picker": _picker,
}


def pinned_hashes(identity: EngineIdentity, cfg: BackendConfig | None = None) -> list[str]:
    """The sorted pinned result hashes for ``cache.pinned`` under ``identity``."""
    cfg = cfg or settings()
    unknown = [n for n in cfg.cache.pinned if n not in PINNERS]
    if unknown:
        raise ValueError(f"cache.pinned names {unknown} unknown (known: {sorted(PINNERS)})")
    ident = EngineIdentity(*identity)
    return sorted({h for name in cfg.cache.pinned for h in PINNERS[name](ident, cfg)})


def _tree_bytes(d: Path) -> int:
    total = 0
    for dirpath, _, files in os.walk(d):
        for f in files:
            try:
                total += os.lstat(os.path.join(dirpath, f)).st_size
            except OSError:
                pass
    return total


def cache_bytes(root: Path | None = None) -> int:
    """Bytes under the result cache (every entry, hidden temp dirs included)."""
    root = results.cache_dir() if root is None else root
    return _tree_bytes(root) if root.is_dir() else 0


def _last_use(d: Path) -> float | None:
    """Last use of a finished tree, or None when it has no run record (never evicted).

    The runner writes run_record.json last and only for a done job (server.engine.jobs), so its
    presence marks a finished tree. It is only stat'ed, never read here: a read would move its
    access time and spoil the LRU order."""
    try:
        st = (d / results.RUN_RECORD).stat()
    except OSError:
        return None
    return max(st.st_atime, st.st_mtime)


def evict(root: Path, max_bytes: int, pinned: set[str]) -> list[str]:
    """Remove least recently used finished, unpinned trees until ``root`` is at most
    ``max_bytes``; returns the removed hashes in removal order."""
    if not root.is_dir():
        return []
    sizes: dict[str, int] = {}
    candidates: list[tuple[float, str]] = []
    total = 0
    for d in root.iterdir():
        size = _tree_bytes(d) if d.is_dir() and not d.is_symlink() else 0
        total += size
        if d.name.startswith(".") or not d.is_dir() or d.is_symlink():
            continue
        if not results.is_result_hash(d.name) or d.name in pinned:
            continue
        used = _last_use(d)
        if used is not None:
            sizes[d.name] = size
            candidates.append((used, d.name))
    removed = []
    for _, h in sorted(candidates):
        if total <= max_bytes:
            break
        src, tmp = root / h, root / f"{EVICT_PREFIX}{h}"
        try:
            os.replace(src, tmp)  # gone from the served tree at once
        except OSError:
            continue
        shutil.rmtree(tmp, ignore_errors=True)
        total -= sizes[h]
        removed.append(h)
        log.info("evicted result %s (%d bytes)", h, sizes[h])
    return removed


def evict_cache(identity: Callable[[], EngineIdentity], max_bytes: int | None = None) -> list[str]:
    """Evict from the live cache under ``cache.max_gb``; nothing without an engine identity."""
    cfg = settings()
    try:
        pins = set(pinned_hashes(EngineIdentity(*identity()), cfg))
        root = results.cache_dir()
    except version.Unavailable:
        return []
    limit = int(cfg.cache.max_gb * 1e9) if max_bytes is None else max_bytes
    return evict(root, limit, pins)


_running = threading.Lock()


def evict_in_background(identity: Callable[[], EngineIdentity]) -> bool:
    """Start one eviction in a daemon thread; False when one is already running."""
    if not _running.acquire(blocking=False):
        return False

    def run():
        try:
            evict_cache(identity)
        except Exception:  # never take the server down for housekeeping
            log.exception("cache eviction failed")
        finally:
            _running.release()

    threading.Thread(target=run, name="cache-evict", daemon=True).start()
    return True


def evict_after_new_job(scope) -> None:
    """The rate limiter's ``on_new_job`` hook: evict in the background with the app's engine
    identity (E3's ``identity_provider`` dependency, so a test override applies here too)."""
    from server.api.compute.results import identity_provider

    app = scope.get("app")
    overrides = getattr(app, "dependency_overrides", {}) if app is not None else {}
    evict_in_background(overrides.get(identity_provider, identity_provider)())

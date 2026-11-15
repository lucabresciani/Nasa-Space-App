"""The engine's single call site for the provenance manifest (AGENTS.md rule 6, F16).

Forwards to WS6's ``pipeline.provenance.manifest.record`` (key, value, units, file, script),
which adds commit and UTC time, validates against contracts/manifest.schema.json and writes the
per-script fragment ``data/interim/manifest/<script>.json`` (``$HOMELINE_MANIFEST_DIR`` in
tests). The engine only adds the file-level SHA-256 key helper and ``to_dir`` (D48): a
context-local fragment directory, so a server building plans in threads never writes into the
shared manifest (``build_plan(manifest_dir=...)``).
"""

from __future__ import annotations

import contextlib
import contextvars
import hashlib
from collections.abc import Iterator
from pathlib import Path

from pipeline.provenance import manifest

FRAGMENT_DIR_ENV = manifest.FRAGMENT_DIR_ENV

# None = WS6's rule (argument, else $HOMELINE_MANIFEST_DIR, else data/interim/manifest/)
_FRAGMENT_DIR: contextvars.ContextVar[Path | None] = contextvars.ContextVar(
    "engine_manifest_dir", default=None)  # fmt: skip


@contextlib.contextmanager
def to_dir(fragment_dir) -> Iterator[None]:
    """Within the block, every engine record goes to ``fragment_dir`` (None: unchanged)."""
    if fragment_dir is None:
        yield
        return
    token = _FRAGMENT_DIR.set(Path(fragment_dir))
    try:
        yield
    finally:
        _FRAGMENT_DIR.reset(token)


def record(key: str, value, units: str | None, file: str, script: str) -> dict:
    """Record one displayed number (WS6 API). Returns the stored entry."""
    return manifest.record(key, value, units, file, script, fragment_dir=_FRAGMENT_DIR.get())


def record_file(data_path: str, local_path, script: str) -> dict:
    """File-level key ``file.<data path>`` = SHA-256 of the bytes, for per-feature values."""
    digest = hashlib.sha256(Path(local_path).read_bytes()).hexdigest()
    return record(f"file.{data_path}", digest, "sha256", data_path, script)


def load_all(fragment_dir=None) -> dict:
    """All manifest entries from every fragment in ``fragment_dir`` (default per WS6 rules)."""
    out: dict = {}
    for frag in manifest.load_fragments(fragment_dir).values():
        out.update(frag)
    return out

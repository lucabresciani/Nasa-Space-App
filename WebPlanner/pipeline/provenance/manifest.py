"""Provenance manifest (F16, AGENTS.md rule 6; contract: contracts/manifest.schema.json).

Every number shown in the web app gets one key in ``web/public/data/manifest.json`` with
``{value, units, file, script, commit, utc}``.

Usage from any workstream::

    from pipeline.provenance.manifest import record
    record("reachable_pct.nom_104.30", 41.7, "%", "scenarios/index.json", __file__)

``record`` adds the git commit and the UTC time, validates the entry against the contract and
writes it to a per-script *fragment* in ``data/interim/manifest/`` (one JSON file per generating
script, so parallel workstreams never write the same file). Re-running a script overwrites its
own keys. ``merge`` (``python -m pipeline.provenance.manifest merge``, called by ``make web``)
combines all fragments into the web manifest and fails if two scripts claim the same key.

Conventions:

* ``key``: dotted name, no whitespace, e.g. ``reachable_pct.nom_104.30``; ``dummy`` is reserved.
  Prefix keys with your output's topic (``v1.``, ``rad.``, ``nav.`` ...) so keys stay unique.
* ``value``: any JSON value; numpy scalars/arrays are converted. NaN/inf are refused: an unknown
  number is ``None`` (AGENTS.md rule 7), never NaN.
* ``units``: string (``"min"``, ``"%"``, ``"deg"``, ``"1"`` for dimensionless) or ``None`` for
  non-numeric values.
* ``file``: the file the number is shown from, preferably its path under ``web/public/data/``
  (e.g. ``"validation/v1.json"``). ``script``: pass ``__file__``. Absolute paths inside the repo
  (or the ``data/`` symlink target) are stored repo-relative.
* ``commit``: ``git rev-parse HEAD``, suffixed ``-dirty`` when tracked files have uncommitted
  changes or untracked files exist under the code paths (``unknown`` if git is unavailable).
* ``utc``: ``YYYY-MM-DDTHH:MM:SSZ`` at the time of the call. ``record`` refuses to write when the
  clock reads before H0 (``config/event.yaml``), and ``check_h0`` fails any such entry in CI.

Environment: ``HOMELINE_MANIFEST_DIR`` overrides the fragment directory (tests, dummy data).
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from pipeline.provenance.check_h0 import load_h0

REPO = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO / "contracts" / "manifest.schema.json"
DEFAULT_FRAGMENT_DIR = REPO / "data" / "interim" / "manifest"
DEFAULT_OUT = REPO / "web" / "public" / "data" / "manifest.json"
FRAGMENT_DIR_ENV = "HOMELINE_MANIFEST_DIR"

RESERVED_KEYS = frozenset({"dummy"})
# Untracked files here make the commit "-dirty" (generating code not in the commit).
CODE_PATHS = ("pipeline", "tools", "config", "contracts")
_KEY_RE = re.compile(r"^\S+$")

__all__ = [
    "record",
    "drop",
    "merge",
    "load_fragments",
    "validate",
    "git_commit",
    "ManifestError",
    "DuplicateKeyError",
    "FRAGMENT_DIR_ENV",
]


class ManifestError(ValueError):
    """A manifest entry or file is invalid."""


class DuplicateKeyError(ManifestError):
    """Two fragments (generating scripts) record the same key."""


# --------------------------------------------------------------------------- helpers


def _utcnow() -> datetime:  # patched in tests
    return datetime.now(UTC)


@lru_cache(maxsize=1)
def _h0() -> datetime:
    return load_h0()


@lru_cache(maxsize=1)
def _schema_validators() -> tuple[Draft202012Validator, Draft202012Validator]:
    schema = json.loads(SCHEMA_PATH.read_text())
    return Draft202012Validator(schema), Draft202012Validator(schema["additionalProperties"])


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(REPO), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


@lru_cache(maxsize=1)
def git_commit() -> str:
    """HEAD commit, with ``-dirty`` if tracked files are modified or untracked files exist
    under ``CODE_PATHS`` (an uncommitted generating script)."""
    try:
        head = _git("rev-parse", "HEAD")
        dirty = _git("status", "--porcelain", "--untracked-files=no") or _git(
            "ls-files", "--others", "--exclude-standard", "--", *CODE_PATHS
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return f"{head}-dirty" if dirty else head


def _rel(path: str | os.PathLike[str]) -> str:
    """Repo-relative posix path when ``path`` is inside the repo or its data/ target."""
    p = Path(path)
    if not p.is_absolute():
        return p.as_posix()
    for base, prefix in ((REPO, ""), ((REPO / "data").resolve(), "data/")):
        for cand in (p, p.resolve()):
            with contextlib.suppress(ValueError):
                return prefix + cand.relative_to(base).as_posix()
    return p.as_posix()


def _jsonable(value: Any) -> Any:
    """Convert numpy types; refuse NaN/inf (unknown must be None)."""

    def default(o: Any) -> Any:
        if hasattr(o, "tolist"):  # numpy scalar or array
            return o.tolist()
        raise TypeError(f"value of type {type(o).__name__} is not JSON-serialisable")

    try:
        text = json.dumps(value, default=default, allow_nan=False)
    except ValueError as e:
        raise ManifestError(f"NaN/inf is not a valid manifest value (use None): {e}") from e
    except TypeError as e:
        raise ManifestError(str(e)) from e
    return json.loads(text)


@lru_cache(maxsize=1)
def _pytest_fragment_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="homeline-manifest-test-"))


def _fragment_dir(fragment_dir: str | os.PathLike[str] | None) -> Path:
    """Explicit argument, else ``$HOMELINE_MANIFEST_DIR``, else the shared default. Under pytest
    without either, a per-process temp dir, so test records never leak into data/interim/."""
    if fragment_dir is not None:
        return Path(fragment_dir)
    env = os.environ.get(FRAGMENT_DIR_ENV)
    if env:
        return Path(env)
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return _pytest_fragment_dir()
    return DEFAULT_FRAGMENT_DIR


def _fragment_name(script_rel: str) -> str:
    stem = script_rel[:-3] if script_rel.endswith(".py") else script_rel
    name = re.sub(r"[^A-Za-z0-9_.-]+", "__", stem.strip("/")).strip("_")
    return (name or "unnamed") + ".json"


@contextlib.contextmanager
def _locked(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(path.name + ".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _atomic_write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        os.chmod(tmp, 0o644)  # mkstemp creates 0600; fragments and manifest.json are shared
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2, sort_keys=True, allow_nan=False)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise


def _check_key(key: Any) -> None:
    if not isinstance(key, str) or not _KEY_RE.match(key):
        raise ManifestError(f"manifest key must be a non-empty string without spaces: {key!r}")
    if key in RESERVED_KEYS:
        raise ManifestError(f"manifest key {key!r} is reserved")


def validate(manifest: dict[str, Any]) -> None:
    """Validate a whole manifest against contracts/manifest.schema.json (raises ManifestError)."""
    full, _ = _schema_validators()
    errors = sorted(full.iter_errors(manifest), key=lambda e: list(e.path))
    if errors:
        raise ManifestError("; ".join(f"{list(e.path)}: {e.message}" for e in errors[:10]))


# --------------------------------------------------------------------------- API


def record(
    key: str,
    value: Any,
    units: str | None,
    file: str | os.PathLike[str],
    script: str | os.PathLike[str],
    *,
    fragment_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Record one displayed number; returns the stored entry.

    Adds ``commit`` and ``utc``; writes to ``<fragment_dir>/<script path>.json``
    (default ``data/interim/manifest/``, or ``$HOMELINE_MANIFEST_DIR``).
    """
    _check_key(key)
    if units is not None and not isinstance(units, str):
        raise ManifestError(f"units must be a string or None, got {units!r}")
    now = _utcnow().astimezone(UTC)
    if now < _h0():
        raise ManifestError(
            f"clock reads {now.isoformat()}, before H0 {_h0().isoformat()}: check `date -u` "
            "and tell C (AGENTS.md rule 8)"
        )
    script_rel = _rel(script)
    entry = {
        "value": _jsonable(value),
        "units": units,
        "file": _rel(file),
        "script": script_rel,
        "commit": git_commit(),
        "utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _, entry_validator = _schema_validators()
    errors = list(entry_validator.iter_errors(entry))
    if errors:
        raise ManifestError(f"{key}: " + "; ".join(e.message for e in errors))

    path = _fragment_dir(fragment_dir) / _fragment_name(script_rel)
    with _locked(path):
        frag = json.loads(path.read_text()) if path.exists() else {}
        frag[key] = entry
        _atomic_write_json(path, frag)
    return entry


def drop(
    keys: Iterable[str],
    script: str | os.PathLike[str],
    *,
    fragment_dir: str | os.PathLike[str] | None = None,
) -> list[str]:
    """Remove retired ``keys`` from ``script``'s own fragment; returns the keys removed.

    Only the calling script's fragment is touched, so a script can never delete another
    workstream's entries. Keys not present (or no fragment at all) are ignored.
    """
    path = _fragment_dir(fragment_dir) / _fragment_name(_rel(script))
    if not path.exists():
        return []
    with _locked(path):
        frag = json.loads(path.read_text())
        gone = [k for k in keys if k in frag]
        if gone:
            for k in gone:
                del frag[k]
            _atomic_write_json(path, frag)
    return gone


def load_fragments(fragment_dir: str | os.PathLike[str] | None = None) -> dict[str, dict]:
    """Return ``{fragment file name: {key: entry}}`` for every fragment."""
    d = _fragment_dir(fragment_dir)
    if not d.is_dir():
        return {}
    return {p.name: json.loads(p.read_text()) for p in sorted(d.glob("*.json"))}


def merge(
    fragment_dir: str | os.PathLike[str] | None = None,
    out_path: str | os.PathLike[str] | None = None,
    *,
    dummy: bool = False,
) -> dict[str, Any]:
    """Merge all fragments into one manifest, validate it, write it and return it.

    Raises DuplicateKeyError (and writes nothing) if a key appears in more than one fragment.
    """
    merged: dict[str, Any] = {}
    owner: dict[str, str] = {}
    dups: list[str] = []
    for name, frag in load_fragments(fragment_dir).items():
        for key, entry in frag.items():
            _check_key(key)
            if key in merged:
                dups.append(f"{key} ({owner[key]}, {name})")
                continue
            merged[key] = entry
            owner[key] = name
    if dups:
        raise DuplicateKeyError("duplicate manifest keys: " + ", ".join(dups))
    result = {"dummy": dummy, **dict(sorted(merged.items()))}
    validate(result)
    _atomic_write_json(Path(out_path) if out_path is not None else DEFAULT_OUT, result)
    return result


# --------------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("merge", help="merge fragments into the web manifest")
    m.add_argument("--fragments", default=None, help=f"default {DEFAULT_FRAGMENT_DIR}")
    m.add_argument("--out", default=None, help=f"default {DEFAULT_OUT}")
    m.add_argument("--dummy", action="store_true", help="mark the output as dummy data")
    args = ap.parse_args(argv)
    try:
        result = merge(args.fragments, args.out, dummy=args.dummy)
    except ManifestError as e:
        print(f"manifest merge FAILED: {e}", file=sys.stderr)
        return 1
    print(f"manifest: {len(result) - 1} keys -> {args.out or DEFAULT_OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

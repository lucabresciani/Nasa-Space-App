"""H0 provenance check (F16, SPEC §9 "Provenance", AGENTS.md CI and rule 8).

Fails (exit 1) if, under ``web/public/data/``:

* any manifest entry's ``utc`` (in any file named ``manifest.json``) is before H0, missing,
  unparseable or has no time zone, or
* any file's modification time is before H0 (git placeholders such as ``.gitkeep`` excepted).

With ``--fragments DIR`` it also checks the per-script manifest fragments
(``data/interim/manifest/*.json``, written by ``pipeline.provenance.manifest.record``).

H0 comes from ``config/event.yaml`` (``h0_utc``, cross-checked against ``h0_local``).
``web/public/data-dummy/`` is never checked: dummy data never reaches the real app, and the
no-dummy-in-public check (``tools/validate_contracts.py``) keeps it out of ``data/``.

In CI the checkout sets every mtime to "now", so the mtime half only bites on the pipeline host;
the manifest-time half is the CI guard.

Usage: ``python -m pipeline.provenance.check_h0 [--data-dir DIR] [--fragments DIR] [--h0 ISO]``.
Stdlib + PyYAML only.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO / "config"
DEFAULT_DATA_DIR = REPO / "web" / "public" / "data"
MANIFEST_NAME = "manifest.json"
# Git placeholders are not data files; they carry the checkout time, not a pipeline time.
PLACEHOLDER_NAMES = frozenset({".gitkeep"})


def parse_aware(text: str) -> datetime:
    """ISO 8601 with ``Z`` or an offset -> aware datetime; naive times are refused."""
    t = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    if t.tzinfo is None or t.utcoffset() is None:
        raise ValueError(f"no time zone in {text!r}")
    return t


def load_h0(config_dir: str | Path = CONFIG_DIR) -> datetime:
    """H0 from ``config/event.yaml``; ``h0_utc`` and ``h0_local`` must name the same instant."""
    event = yaml.safe_load((Path(config_dir) / "event.yaml").read_text()) or {}
    h0 = parse_aware(event["h0_utc"])
    if "h0_local" in event and parse_aware(event["h0_local"]) != h0:
        raise ValueError(
            f"config/event.yaml h0_utc {event['h0_utc']!r} and h0_local "
            f"{event['h0_local']!r} disagree"
        )
    return h0


def _check_entries(entries: dict, rel: str, h0: datetime) -> list[str]:
    problems = []
    for key, entry in entries.items():
        if key == "dummy":
            continue
        utc = entry.get("utc") if isinstance(entry, dict) else None
        if not isinstance(utc, str):
            problems.append(f"{rel}: {key}: missing utc")
            continue
        try:
            t = parse_aware(utc)
        except ValueError as e:
            problems.append(f"{rel}: {key}: bad utc {utc!r} ({e})")
            continue
        if t < h0:
            problems.append(f"{rel}: {key}: utc {utc} is before H0 {h0.isoformat()}")
    return problems


def _check_manifest_file(path: Path, rel: str, h0: datetime) -> list[str]:
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        return [f"{rel}: unreadable manifest ({e})"]
    if not isinstance(doc, dict):
        return [f"{rel}: manifest is not a JSON object"]
    return _check_entries(doc, rel, h0)


def check(data_dir: str | Path, h0: datetime) -> list[str]:
    """Problems in a web data tree (empty list = pass). A missing directory passes."""
    data_dir = Path(data_dir)
    if "data-dummy" in data_dir.resolve().parts:
        raise ValueError("the H0 check applies to web/public/data/ only, never data-dummy/")
    if not data_dir.is_dir():
        return []
    h0_ts = h0.timestamp()
    problems: list[str] = []
    for p in sorted(data_dir.rglob("*")):
        if not p.is_file() or p.name in PLACEHOLDER_NAMES:
            continue
        rel = p.relative_to(data_dir).as_posix()
        mtime = p.stat().st_mtime
        if mtime < h0_ts:
            when = datetime.fromtimestamp(mtime, h0.tzinfo).isoformat(timespec="seconds")
            problems.append(f"{rel}: mtime {when} is before H0 {h0.isoformat()}")
        if p.name == MANIFEST_NAME:
            problems.extend(_check_manifest_file(p, rel, h0))
    return problems


def check_fragments(fragment_dir: str | Path, h0: datetime) -> list[str]:
    """Problems in a manifest fragment directory (every ``*.json`` is a key -> entry map)."""
    d = Path(fragment_dir)
    if not d.is_dir():
        return []
    problems: list[str] = []
    for p in sorted(d.glob("*.json")):
        problems.extend(_check_manifest_file(p, f"fragments/{p.name}", h0))
    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Fail if any web data predates H0.")
    ap.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    ap.add_argument("--fragments", type=Path, default=None,
                    help="also check manifest fragments, e.g. data/interim/manifest")
    ap.add_argument("--h0", default=None, help="override H0 (ISO 8601 with offset)")
    args = ap.parse_args(argv)
    h0 = parse_aware(args.h0) if args.h0 else load_h0()
    problems = check(args.data_dir, h0)
    if args.fragments is not None:
        problems += check_fragments(args.fragments, h0)
    if problems:
        print(f"H0 check FAILED ({len(problems)} problem(s), H0 = {h0.isoformat()}):")
        for line in problems:
            print("  " + line)
        return 1
    print(f"H0 check OK: nothing in {args.data_dir} predates H0 {h0.isoformat()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

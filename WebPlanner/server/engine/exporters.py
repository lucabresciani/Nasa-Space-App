"""Exporter registry next to build_plan (D76): extra files derived from a finished result tree.

An exporter is ``fn(result_dir: Path) -> list[{"path": str, "kind": str}]``: it writes its files
into ``result_dir`` (relative, servable paths) and returns one entry per file. An exporter that
declares a ``context`` parameter is called ``fn(result_dir, context=...)`` with what the plan job
knows beyond the tree (its inputs, the route feasibility, the field rasters; plan_job
``export_context``); run_exporters passes ``{}`` when the caller gives none. The plan job
(server.engine.plan_job) calls every registered exporter after build_plan, before manifest.json
and run_record.json are written; each returned file gets a manifest entry carrying its ``kind``
(e.g. "sim_plan"), so GET /results/{hash}/<path> serves it like any other file of the tree.

Registered here (D110): "mission" (server.engine.mission.export_mission, kind "sim_plan"):
mission.json, the simulator plan (contracts/bundle/mission.schema.json, D103), in every live
result tree. Parity compares only the static tree's files (server/tests/parity_harness.py
``server_files``), so exported files are never compared. Nothing here assumes an exporter's file
name or schema.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from pathlib import Path

from server.engine import results

Exporter = Callable[..., list[dict]]
SCRIPT = "server/engine/exporters.py"
MANIFEST_KEY = "export.{name}.{path}"  # manifest.json key of one exported file

EXPORTERS: dict[str, Exporter] = {}


def register_exporter(name: str, fn: Exporter) -> None:
    if not name or "." in name:
        raise ValueError(f"exporter name {name!r} must be non-empty and without '.'")
    EXPORTERS[name] = fn


def unregister_exporter(name: str) -> None:
    EXPORTERS.pop(name, None)


def _wants_context(fn: Exporter) -> bool:
    try:
        return "context" in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def run_exporters(result_dir: Path, commit: str, utc: str,
                  exporters: dict[str, Exporter] | None = None,
                  context: dict | None = None) -> dict[str, dict]:
    """Run every exporter on ``result_dir``; returns the manifest entries of their files."""
    entries: dict[str, dict] = {}
    for name, fn in sorted((EXPORTERS if exporters is None else exporters).items()):
        kw = {"context": dict(context or {}, commit=commit)} if _wants_context(fn) else {}
        for item in fn(result_dir, **kw) or []:
            rel, kind = item.get("path"), item.get("kind")
            if not isinstance(rel, str) or not isinstance(kind, str) or not kind:
                raise ValueError(f"exporter {name!r} returned {item!r}: need path and kind")
            if rel in (results.RUN_RECORD, "manifest.json"):
                raise ValueError(f"exporter {name!r} may not write {rel}")
            f = result_dir.joinpath(*results.safe_parts(rel))
            if not f.is_file():
                raise ValueError(f"exporter {name!r} listed {rel!r} but did not write it")
            entries[MANIFEST_KEY.format(name=name, path=rel)] = {
                "value": rel, "units": None, "file": rel, "script": SCRIPT, "commit": commit,
                "utc": utc, "kind": kind, "exporter": name}
    return entries


def _register_builtin() -> None:
    from server.engine.mission import export_mission

    register_exporter("mission", export_mission)


_register_builtin()

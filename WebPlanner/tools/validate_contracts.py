#!/usr/bin/env python3
"""Validate web-facing data against contracts/*.schema.json (SPEC §6, §6.1, §6.2).

Checks, for web/public/data/ and web/public/data-dummy/ (overridable):
  * every .json/.geojson file that matches a pattern in SCHEMA_MAP validates (draft 2020-12);
  * no file under the public data tree has a top-level "dummy": true;
  * every index file (schema requires "dummy") in the dummy tree has "dummy": true;
  * no file in either tree exceeds MAX_BYTES;
  * JSON files with no matching schema produce a warning (not a failure);
  * with --interim DIR: pipeline-internal JSON (INTERIM_SCHEMA_MAP) validates.
Also self-checks that every schema in contracts/ is a valid draft 2020-12 schema.

Exit 0 when everything passes (including empty or missing trees), 1 otherwise.
Dependencies: stdlib + jsonschema.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from pathlib import Path

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

REPO = Path(__file__).resolve().parent.parent
CONTRACTS_DIR = REPO / "contracts"
DATA_DIR = REPO / "web" / "public" / "data"
DUMMY_DIR = REPO / "web" / "public" / "data-dummy"

MAX_BYTES = 50 * 1024 * 1024  # AGENTS.md rule 9: nothing over 50 MB in git
CONTRACT_VERSION_KEY = "x-contract-version"

# Path pattern (relative to the data root, "/"-separated, one fnmatch glob per segment)
# -> schema file in contracts/. First match wins; patterns must not overlap.
SCHEMA_MAP: list[tuple[str, str]] = [
    # SPEC §6
    ("scenarios/index.json", "scenarios_index.schema.json"),
    ("scenarios/*/isochrones.geojson", "isochrones.schema.json"),
    ("scenarios/bands_*.geojson", "bands.schema.json"),
    ("scenarios/*/edges.geojson", "edges.schema.json"),
    ("scenarios/*/partner.geojson", "partner.schema.json"),
    ("stations.json", "stations.schema.json"),
    ("cards/*.json", "card.schema.json"),
    ("route_*.geojson", "route.schema.json"),
    ("timeline_*.json", "timeline.schema.json"),
    ("trade_table.json", "trade_table.schema.json"),
    ("pad.json", "pad.schema.json"),
    ("conditions/rad.json", "rad.schema.json"),
    ("manifest.json", "manifest.schema.json"),
    # SPEC §6.1
    ("fields/index.json", "fields_index.schema.json"),
    ("fp3d/index.json", "fp3d_index.schema.json"),
    ("fp3d/horizon_ring.json", "horizon_ring.schema.json"),
    ("localisation/*.json", "localisation.schema.json"),
    # SPEC §6.2
    ("nav/montecarlo_*.json", "montecarlo.schema.json"),
    ("nav/fixes.json", "fixes.schema.json"),
    ("nav/tracks_*.geojson", "tracks.schema.json"),
    ("nav/fix_interval_summary.json", "fix_interval_summary.schema.json"),
    ("vo/probe.json", "vo_probe.schema.json"),
    ("vo/drift.json", "vo_drift.schema.json"),
    # Beyond §6: files named in SPEC §2 (F13, F14) and the briefs (contracts/README.md)
    ("validation/v1.json", "v1.schema.json"),
    ("validation/v2.json", "v2.schema.json"),
    ("validation/coverage.json", "coverage.schema.json"),
    ("validation/coreg.json", "coreg.schema.json"),
    ("validation/kats.json", "kats.schema.json"),
    ("conditions/rems.json", "rems.schema.json"),
    ("conditions/clock.json", "clock.schema.json"),
    ("conditions/donki.json", "donki.schema.json"),
    # v1.1.0: siting image corners (WS2), basemap TileJSON and cell-state image index (make web)
    ("siting_png.json", "siting_png.schema.json"),
    ("tiles/basemap/tilejson.json", "tilejson.schema.json"),
    ("terrain/cellstate.json", "cellstate.schema.json"),
    # v1.1.2: conservative cell states (WS1 cellstate_3m_conservative.tif, make web)
    ("terrain/cellstate_conservative.json", "cellstate.schema.json"),
    # v1.1.4: D21 rover parking options (WS2 pipeline/engine/padpick.py; C layout 16:17). Four
    # segments under scenarios/pads/, so no overlap with the three-segment scenario rows above.
    ("scenarios/pads/index.json", "pads_index.schema.json"),
    ("scenarios/pads/*/summary.json", "pad_summary.schema.json"),
    ("scenarios/pads/*/bands_*.geojson", "bands.schema.json"),
    ("scenarios/pads/*/edges.geojson", "edges.schema.json"),
    ("scenarios/pads/*/partner.geojson", "partner.schema.json"),
    ("scenarios/pads/*/route_*.geojson", "route.schema.json"),
    ("scenarios/pads/*/timeline_*.json", "timeline.schema.json"),
    # v1.1.5: WS2 physiology golden vectors (D41; the simulator's C# port must reproduce them)
    ("physio/golden.json", "golden.schema.json"),
    # Design contracts v1 (DESIGN §6, D3): labels, terrain tile metadata, highlight polygons
    ("labels.json", "labels.schema.json"),
    ("terrain/tiles.json", "terrain_tiles.schema.json"),
    ("terrain_low/tiles.json", "terrain_tiles.schema.json"),
    ("highlights/*.geojson", "highlights.schema.json"),
]

# Contracts for files outside the data root (validated by their own tests):
# storyboard.schema.json covers web/public/story/*.json (tests/test_design_contracts.py).
NON_DATA_SCHEMAS: tuple[str, ...] = ("storyboard.schema.json",)

# Pipeline-internal JSON (not web-facing), relative to data/interim/. Checked only with
# --interim DIR (producers also validate on write).
INTERIM_SCHEMA_MAP: list[tuple[str, str]] = [
    ("horizon/horizons/*.json", "horizon.schema.json"),
    ("horizon/navcam_frames.json", "navcam_frames.schema.json"),
    ("terrain/coverage.json", "coverage.schema.json"),
    ("terrain/coreg.json", "coreg.schema.json"),
]

JSON_SUFFIXES = {".json", ".geojson"}


def _check_pads_index(rel: str, doc) -> list[str]:
    """v1.1.4: exactly one official row, equal to the top-level ``official``; unique ids."""
    rows = doc.get("pads") if isinstance(doc, dict) else None
    if not isinstance(rows, list):
        return []
    rows = [r for r in rows if isinstance(r, dict)]
    out = []
    official = [r.get("id") for r in rows if r.get("official") is True]
    if len(official) != 1:
        out.append(f"exactly one pad row must have official: true (found {len(official)})")
    elif "official" in doc and doc["official"] != official[0]:
        out.append(f"official {doc['official']!r} is not the official row {official[0]!r}")
    ids = [r.get("id") for r in rows]
    dup = sorted({str(i) for i in ids if ids.count(i) > 1})
    if dup:
        out.append(f"duplicate pad ids {dup}")
    return out


def _check_pad_summary(rel: str, doc) -> list[str]:
    """v1.1.4: id = folder name under scenarios/pads/; each headline key = its budget_min."""
    if not isinstance(doc, dict):
        return []
    out = []
    parts = rel.split("/")
    if len(parts) >= 2 and doc.get("id") != parts[-2]:
        out.append(f"id {doc.get('id')!r} is not the folder name {parts[-2]!r}")
    headline = doc.get("headline")
    for key, h in (headline.items() if isinstance(headline, dict) else []):
        b = h.get("budget_min") if isinstance(h, dict) else None
        try:
            same = float(key) == b
        except ValueError:
            same = False
        if isinstance(b, int | float) and not same:
            out.append(f"headline key {key!r} has budget_min {b}")
    return out


# Checks JSON Schema cannot express in the keyword subset the browser checker supports
# (web/src/data/schema.ts): schema file -> fn(data-root-relative path, doc) -> error messages.
SEMANTIC_CHECKS = {
    "pads_index.schema.json": _check_pads_index,
    "pad_summary.schema.json": _check_pad_summary,
}


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def match_schema(rel_path: str, table: list[tuple[str, str]] | None = None) -> str | None:
    """Return the schema filename for a data-root-relative posix path, or None."""
    parts = rel_path.split("/")
    for pattern, schema in SCHEMA_MAP if table is None else table:
        pat_parts = pattern.split("/")
        if len(pat_parts) == len(parts) and all(
            fnmatchcase(p, q) for p, q in zip(parts, pat_parts, strict=True)
        ):
            return schema
    return None


def load_schemas(contracts_dir: Path, report: Report) -> dict[str, dict]:
    """Load and self-check every *.schema.json; return {filename: schema}."""
    schemas: dict[str, dict] = {}
    for path in sorted(contracts_dir.glob("*.schema.json")):
        try:
            schema = json.loads(path.read_text(encoding="utf-8"))
            Draft202012Validator.check_schema(schema)
        except (json.JSONDecodeError, SchemaError) as exc:
            report.errors.append(f"{path}: invalid schema: {exc}")
            continue
        if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            report.errors.append(f"{path}: $schema must be draft 2020-12")
        for key in ("$id", "title", "description", CONTRACT_VERSION_KEY):
            if key not in schema:
                report.errors.append(f"{path}: missing {key!r}")
        schemas[path.name] = schema
    for _, name in SCHEMA_MAP + INTERIM_SCHEMA_MAP:
        if name not in schemas:
            report.errors.append(f"{contracts_dir / name}: mapped schema missing or invalid")
    return schemas


def is_index_schema(schema: dict) -> bool:
    return "dummy" in schema.get("required", [])


def check_tree(root: Path, schemas: dict[str, dict], report: Report, *, public: bool) -> int:
    """Validate one data tree. Returns the number of files checked."""
    if not root.is_dir():
        return 0
    n = 0
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        n += 1
        rel = path.relative_to(root).as_posix()
        size = path.stat().st_size
        if size > MAX_BYTES:
            report.errors.append(f"{path}: {size} bytes exceeds {MAX_BYTES} byte limit")
        if path.suffix.lower() not in JSON_SUFFIXES:
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            report.errors.append(f"{path}: not valid JSON: {exc}")
            continue
        top_dummy = doc.get("dummy") if isinstance(doc, dict) else None
        if public and top_dummy is True:
            report.errors.append(f'{path}: "dummy": true is not allowed in public data')
        schema_name = match_schema(rel)
        if schema_name is None:
            report.warnings.append(f"{path}: no contract schema matches {rel!r}")
            continue
        schema = schemas.get(schema_name)
        if schema is None:
            continue  # already reported by load_schemas
        validator = Draft202012Validator(schema)
        for err in sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path)):
            loc = "/".join(str(p) for p in err.absolute_path) or "<root>"
            report.errors.append(f"{path} [{schema_name}] at {loc}: {err.message}")
        for msg in SEMANTIC_CHECKS.get(schema_name, lambda *_: [])(rel, doc):
            report.errors.append(f"{path} [{schema_name}]: {msg}")
        if not public and is_index_schema(schema) and top_dummy is not True:
            report.errors.append(f'{path}: index file in dummy tree must have "dummy": true')
    return n


def check_interim(root: Path, schemas: dict[str, dict], report: Report) -> int:
    """Validate pipeline-internal JSON under ``root`` (data/interim/) against
    INTERIM_SCHEMA_MAP. Unmatched files are ignored (interim trees hold many other files)."""
    if not root.is_dir():
        return 0
    n = 0
    for path in sorted(p for p in root.rglob("*.json") if p.is_file()):
        name = match_schema(path.relative_to(root).as_posix(), INTERIM_SCHEMA_MAP)
        if name is None or name not in schemas:
            continue
        n += 1
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            report.errors.append(f"{path}: not valid JSON: {exc}")
            continue
        for err in Draft202012Validator(schemas[name]).iter_errors(doc):
            loc = "/".join(str(p) for p in err.absolute_path) or "<root>"
            report.errors.append(f"{path} [{name}] at {loc}: {err.message}")
    return n


def run(
    data_dir: Path = DATA_DIR,
    dummy_dir: Path = DUMMY_DIR,
    contracts_dir: Path = CONTRACTS_DIR,
    interim_dir: Path | None = None,
) -> Report:
    report = Report()
    schemas = load_schemas(contracts_dir, report)
    check_tree(data_dir, schemas, report, public=True)
    check_tree(dummy_dir, schemas, report, public=False)
    if interim_dir is not None:
        check_interim(interim_dir, schemas, report)
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", type=Path, default=DATA_DIR, help="public data tree")
    ap.add_argument("--dummy", type=Path, default=DUMMY_DIR, help="dummy data tree")
    ap.add_argument("--contracts", type=Path, default=CONTRACTS_DIR, help="schema directory")
    ap.add_argument("--interim", type=Path, default=None,
                    help="also check pipeline-internal JSON here (e.g. data/interim)")
    args = ap.parse_args(argv)

    report = run(args.data, args.dummy, args.contracts, args.interim)
    for w in report.warnings:
        print(f"WARN  {w}")
    for e in report.errors:
        print(f"FAIL  {e}")
    status = "OK" if report.ok else "FAILED"
    print(f"validate_contracts: {status} ({len(report.errors)} errors, "
          f"{len(report.warnings)} warnings)")
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())

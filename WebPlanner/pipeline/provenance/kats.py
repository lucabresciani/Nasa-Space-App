"""KAT pass list for the scorecard (F16, SPEC §9) -> ``data/interim/validation/kats.json``.

Runs the repo's pytest suite (or reads an existing JUnit XML from CI / the freeze run) and writes
one row per test: node id, SPEC §9 area, feature IDs, outcome (passed / failed / skipped) and the
failure or skip reason. Nothing is filtered: collection errors and errors count as failed, xfail
as skipped (reason prefixed ``xfail:``), xpass as passed. Optionally adds vitest rows from a
``vitest run --reporter=json`` file (web tests).

Schema: ``contracts/kats.schema.json`` (adopted by C from the WS6 proposal).
Manifest keys: ``kats.summary.{total,passed,
failed,skipped}`` (file ``validation/kats.json``).

CLI::

    python -m pipeline.provenance.kats [--junit FILE] [--vitest-json FILE] [--out FILE]
                                       [--exit-zero]

Without ``--junit`` it runs pytest itself. Exit code 1 when any test failed (after writing the
file), unless ``--exit-zero``.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from datetime import UTC
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from pipeline.provenance import manifest
from pipeline.provenance.manifest import record

REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO / "data" / "interim" / "validation" / "kats.json"
WEB_PATH = "validation/kats.json"  # under web/public/data/ (`make web` copies it unchanged)
CONTRACT = REPO / "contracts" / "kats.schema.json"

# Test file -> (SPEC §9 area, feature IDs): a classification of the test files named in SPEC §4.3
# and the briefs, not a constant. Unlisted files are "other" with no feature, never guessed.
FILE_MAP: dict[str, tuple[str, list[str]]] = {
    "tests/test_coverage.py": ("Terrain", ["F1"]),
    "tests/test_coreg.py": ("Co-registration", ["F1"]),
    "tests/test_router.py": ("Router", ["F4"]),
    "tests/test_physio.py": ("Physiology", ["F3"]),
    "tests/test_haul.py": ("Haul", ["F10"]),
    "tests/test_horizon.py": ("Horizon and camera", ["F12"]),
    "tests/test_cahvor.py": ("Horizon and camera", ["F12"]),
    "tests/test_clock.py": ("Clock", ["F14"]),
    "tests/test_rad.py": ("RAD", ["F14"]),
    "tests/test_provenance.py": ("Provenance", ["F16"]),
    "tests/test_fields_png.py": ("HUD fields", ["F18"]),
    "tests/test_nav.py": ("F21 navigation", ["F21"]),
    "tests/test_vo.py": ("X8 visual odometry", ["X8"]),
    "tests/test_fp3d_export.py": ("3D", ["F20"]),
}
# Web test directories (vitest) -> area, features. web/src/fp3d/ (the first-person 3D scene) was
# removed by D99; its vitest rows leave kats.json at the next `make kats` + `make web`.
WEB_DIR_MAP: dict[str, tuple[str, list[str]]] = {
    "web/src/hud/": ("HUD logic", ["F18"]),
    "web/src/nav/": ("F21 navigation", ["F21"]),
}
# Tests in a mixed file that belong to another area (file, test-name regex, area, features).
NAME_RULES: list[tuple[str, re.Pattern[str], str, list[str]]] = [
    ("tests/test_nav.py", re.compile(r"skyline"), "F22 skyline fix", ["F22"]),
    ("tests/test_provenance.py", re.compile(r"test_v1_"), "V1", ["F13"]),
]


def schema() -> dict[str, Any]:
    return json.loads(CONTRACT.read_text())


def classify(test_id: str) -> tuple[str, list[str]]:
    """(area, features) for a test id ``path::[Class::]name`` or ``web/... > title``."""
    path, _, name = test_id.partition("::")
    if " > " in test_id and not name:
        path = test_id.split(" > ", 1)[0]
        for prefix, (area, feats) in WEB_DIR_MAP.items():
            if path.startswith(prefix):
                return area, list(feats)
        return "other", []
    for f, rx, area, feats in NAME_RULES:
        if path == f and rx.search(name):
            return area, list(feats)
    area, feats = FILE_MAP.get(path, ("other", []))
    return area, list(feats)


def _row(test_id: str, outcome: str, reason: str | None, duration: float | None) -> dict:
    area, feats = classify(test_id)
    return {"id": test_id, "area": area, "features": feats, "outcome": outcome,
            "reason": reason, "duration_s": duration}


def _first_line(text: str | None) -> str | None:
    if not text or not text.strip():
        return None
    return text.strip().splitlines()[0][:300] or None


def _test_id(tc: ET.Element) -> str:
    name = tc.get("name", "")
    classname = tc.get("classname", "")
    file = tc.get("file")
    if not classname:  # collection error: pytest puts the module in `name`
        return name
    if file:
        module = file[:-3].replace("/", ".") if file.endswith(".py") else file
        rest = classname[len(module) + 1:] if classname.startswith(module + ".") else ""
        return "::".join([file, *([rest.replace(".", "::")] if rest else []), name])
    # xunit2 (no file attribute): the longest dotted prefix that is a .py file in the repo
    parts = classname.split(".")
    for i in range(len(parts), 0, -1):
        cand = "/".join(parts[:i]) + ".py"
        if (REPO / cand).exists():
            return "::".join([cand, *parts[i:], name])
    return f"{classname}::{name}"


def parse_junit(path: str | os.PathLike[str]) -> list[dict[str, Any]]:
    """Rows from a pytest JUnit XML (xunit1 preferred; xunit2 works with path guessing)."""
    rows = []
    for tc in ET.parse(path).getroot().iter("testcase"):
        dur = tc.get("time")
        duration = float(dur) if dur not in (None, "") else None
        fail = tc.find("failure")
        if fail is None:
            fail = tc.find("error")
        skip = tc.find("skipped")
        if fail is not None:
            outcome = "failed"
            reason = _first_line(fail.get("message")) or _first_line(fail.text) or fail.tag
        elif skip is not None:
            outcome = "skipped"
            reason = _first_line(skip.get("message")) or _first_line(skip.text)
            if skip.get("type") == "pytest.xfail":
                reason = f"xfail: {reason}" if reason else "xfail"
        else:
            outcome, reason = "passed", None
        rows.append(_row(_test_id(tc), outcome, reason, duration))
    return rows


def parse_vitest_json(path: str | os.PathLike[str]) -> list[dict[str, Any]]:
    """Rows from ``vitest run --reporter=json --outputFile=...`` (Jest-compatible JSON)."""
    doc = json.loads(Path(path).read_text())
    rows = []
    status_map = {"passed": "passed", "failed": "failed", "skipped": "skipped",
                  "pending": "skipped", "todo": "skipped", "disabled": "skipped"}
    for tr in doc.get("testResults", []):
        name = Path(tr.get("name", ""))
        try:
            rel = name.resolve().relative_to(REPO).as_posix()
        except ValueError:
            rel = name.as_posix()
        for a in tr.get("assertionResults", []):
            tid = " > ".join([rel, *a.get("ancestorTitles", []), a.get("title", "")])
            outcome = status_map.get(a.get("status"), "failed")  # unknown status: not a pass
            msgs = a.get("failureMessages") or []
            reason = _first_line(msgs[0]) if msgs else (
                None if outcome == "passed" else a.get("status"))
            dur = a.get("duration")
            rows.append(_row(tid, outcome, reason, dur / 1000.0 if dur is not None else None))
        if tr.get("status") == "failed" and not tr.get("assertionResults"):
            rows.append(_row(rel, "failed", _first_line(tr.get("message")) or "suite failed",
                             None))
    return rows


def write_kats(
    rows: list[dict[str, Any]],
    out_path: str | os.PathLike[str] = DEFAULT_OUT,
    *,
    runner: str,
    exit_codes: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Validate and write ``kats.json``; record the summary counts in the manifest."""
    counts = {k: sum(r["outcome"] == k for r in rows) for k in ("passed", "failed", "skipped")}
    doc = {
        "generated_utc": manifest._utcnow().astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "commit": manifest.git_commit(),
        "runner": runner,
        "summary": {"total": len(rows), **counts},
        "exit_codes": exit_codes or {},
        "areas": sorted({r["area"] for r in rows}),
        "tests": rows,
    }
    Draft202012Validator(schema()).validate(doc)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, allow_nan=False) + "\n")
    for k, v in doc["summary"].items():
        record(f"kats.summary.{k}", v, "count", WEB_PATH, __file__)
    return doc


def run_pytest(extra_args: list[str] | None = None) -> tuple[list[dict[str, Any]], int]:
    """Run the repo's pytest suite once with a JUnit XML; return (rows, pytest exit code)."""
    with tempfile.TemporaryDirectory() as td:
        xml = Path(td) / "junit.xml"
        cmd = [sys.executable, "-m", "pytest", "-o", "junit_family=xunit1",
               f"--junitxml={xml}", "-q", "-p", "no:cacheprovider", *(extra_args or [])]
        proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
        if not xml.exists():
            raise RuntimeError(f"pytest wrote no JUnit XML (exit {proc.returncode}):\n"
                               f"{proc.stdout[-2000:]}\n{proc.stderr[-2000:]}")
        return parse_junit(xml), proc.returncode


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--junit", help="existing pytest JUnit XML (default: run pytest now)")
    ap.add_argument("--vitest-json", help="vitest JSON report to include (web tests)")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--exit-zero", action="store_true", help="exit 0 even if tests failed")
    a = ap.parse_args(argv)

    exit_codes: dict[str, int] = {}
    if a.junit:
        rows = parse_junit(a.junit)
    else:
        rows, exit_codes["pytest"] = run_pytest()
    runner = "pytest"
    if a.vitest_json:
        rows += parse_vitest_json(a.vitest_json)
        runner = "pytest+vitest"
    doc = write_kats(rows, a.out, runner=runner, exit_codes=exit_codes)
    print(json.dumps(doc["summary"]), "->", a.out)
    for r in doc["tests"]:
        if r["outcome"] != "passed":
            print(f"  {r['outcome']:7} {r['id']}  ({r['reason']})")
    return 0 if a.exit_zero or doc["summary"]["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

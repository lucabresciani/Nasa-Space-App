"""Build every WS4 output from the cache (`python -m pipeline.conditions`, `make conditions`).

Reads only ``data/raw/conditions/`` (filled by ``python -m pipeline.conditions.fetch all``) and
config/, writes ``data/interim/conditions/{rad,clock,rems,donki}.json`` (``make web`` copies them
to ``web/public/data/conditions/``), validates each against its contract and records every
displayed value in the provenance manifest.
"""

from __future__ import annotations

import argparse
import sys
import traceback
from datetime import UTC, datetime
from pathlib import Path

from pipeline.conditions import clockfile, donki, rad, rems
from pipeline.conditions.config import INTERIM, RAW, REPO, load_conditions


def _rad(cfg, now, out: Path) -> Path:
    storm_p = RAW / "rad" / "rad_l2_storm.txt"
    if not storm_p.exists():
        raise FileNotFoundError(f"{storm_p} missing (python -m pipeline.conditions.fetch rad)")
    storm = rad.parse_cdas_text(storm_p.read_text())
    latest = None
    latest_p = RAW / "rad" / "rad_l2_latest.txt"
    if latest_p.exists():
        try:
            latest = rad.parse_cdas_text(latest_p.read_text())
        except ValueError as e:  # unknown stays unknown: latest = unavailable
            print(f"  rad: latest cache unreadable ({e}); latest = unavailable")
    return rad.write_rad(rad.build_rad(storm, latest, cfg, now), out / rad.WEB_PATH)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build WS4 conditions outputs from the cache")
    ap.add_argument("--out", type=Path, default=INTERIM, help="files go to <out>/conditions/")
    a = ap.parse_args(argv)
    cfg = load_conditions()
    now = datetime.now(UTC)
    steps = {
        "rad": lambda: _rad(cfg, now, a.out),
        "clock": lambda: clockfile.write_clock(clockfile.build_clock(cfg), a.out),
        "rems": lambda: rems.write_rems(rems.build_rems(cfg, now), a.out / rems.WEB_PATH),
        "donki": lambda: donki.write_donki(donki.build_donki(cfg), a.out / donki.WEB_PATH),
    }
    failed = []
    for name, step in steps.items():
        try:
            p = step()
            print(f"  {name}: {p.relative_to(REPO) if p.is_relative_to(REPO) else p}")
        except Exception as e:  # report every failure, build the rest
            failed.append(name)
            print(f"  {name}: FAILED {type(e).__name__}: {e}", file=sys.stderr)
            traceback.print_exc(limit=2)
    print(f"conditions: {len(steps) - len(failed)}/{len(steps)} outputs written"
          + (f"; failed: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
